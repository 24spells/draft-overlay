// Full game replays (Ken 2026-11-15: "a full fledged action by action viewer where you can play back
// your game to study as if you were there again", the first step toward chess.com-style review).
//
// A separate pass over Player.log (arena-records.ts keeps its own simpler per-turn summary). Arena's
// game engine sends the game as a stream of state messages: full or changed objects (cards, tokens,
// abilities), zones, players' life, the turn and step, and annotations for everything that happened
// (a card moved and why, damage, life, targets, counters, tokens). This keeps the board up to date
// message by message and saves a FRAME whenever something happened or the step changed: the board,
// your hand, both graveyards and exiles, the stack, life, library sizes, and what happened in words
// (as structured events the site turns into sentences).
//
// What it cannot show: the opponent's hand (only how many cards) and library order. Arena hides them.
// Also kept per frame when Arena asks you to act: the cards you could cast or play at that moment
// (for the decision review later; not shown yet).
//
// Pure: log text in, replays out. Like the rest of the overlay: card ids and game events only, never
// player names or account ids.

export const REPLAY_VERSION = 1;

/** One object on the board or stack. c: 0 yours, 1 the opponent's. f: flags (FLAG_*). */
export type RObj = { i: number; g: number; c: 0 | 1; f?: number; p?: number; t?: number; d?: number; k?: number; at?: number; bl?: number[]; src?: number };
export const FLAG = { tapped: 1, attacking: 2, blocking: 4, token: 8, sick: 16, ability: 32, land: 64, creature: 128 } as const;

/** What happened. w: 0 you, 1 the opponent. g: the card (grpId). to: a card, or "p0"/"p1" for a player. */
export type REvent = {
  k:
    | 'land' | 'cast' | 'draw' | 'dies' | 'destroyed' | 'sacrificed' | 'discarded' | 'exiled' | 'milled' | 'surveiled'
    | 'countered' | 'returned' | 'put' | 'moved' | 'damage' | 'life' | 'target' | 'token' | 'counter' | 'attack'
    | 'block' | 'mulligan' | 'result';
  w?: 0 | 1;
  g?: number;
  n?: number;
  to?: number | string;
  z?: string;
  r?: string;
};

export type RFrame = {
  /** Turn number and whose turn (0 yours, 1 the opponent's). */
  n: number;
  a: 0 | 1;
  /** Step, short: Upkeep, Draw, Main1, BeginCombat, DeclareAttack, DeclareBlock, Damage, EndCombat, Main2, End, Cleanup. */
  s: string;
  /** Life: [you, opponent]. */
  l: [number, number];
  /** Battlefield, in Arena's order. */
  bf: RObj[];
  /** Your hand (card ids), the opponent's hand size. */
  h: number[];
  oh: number;
  /** Graveyards and exiles: [yours, theirs], oldest first. */
  gy: [number[], number[]];
  ex: [number[], number[]];
  /** The stack, top first. */
  sk: RObj[];
  /** Library sizes: [yours, theirs]. */
  lib: [number, number];
  /** What happened since the last frame. */
  e: REvent[];
  /** When Arena asked you to act here: the cards you could cast or play. */
  can?: number[];
};

export type Replay = { v: number; id: string; seat: number; frames: RFrame[] };

type Obj = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const detail = (a: Obj, key: string): (string | number)[] => {
  const d = (a.details ?? []).find((x: Obj) => x.key === key);
  return d ? (d.valueString ?? d.valueInt32 ?? []) : [];
};
const STEP: Record<string, string> = {
  Step_Upkeep: 'Upkeep', Step_Draw: 'Draw', Step_BeginCombat: 'BeginCombat', Step_DeclareAttack: 'DeclareAttack',
  Step_DeclareBlock: 'DeclareBlock', Step_CombatDamage: 'Damage', Step_FirstStrikeDamage: 'FirstStrike', Step_EndCombat: 'EndCombat',
  Step_End: 'End', Step_Cleanup: 'Cleanup',
};
const PHASE: Record<string, string> = { Phase_Main1: 'Main1', Phase_Main2: 'Main2', Phase_Beginning: 'Upkeep', Phase_Combat: 'BeginCombat', Phase_Ending: 'End' };

/** Every game's replay in the log, keyed like the game records ("<matchId>-<gameNumber>"). */
export function readReplays(text: string): Map<string, Replay> {
  const out = new Map<string, Replay>();
  let seat = 0;
  let rep: Replay | null = null;
  let objects = new Map<number, Obj>();
  let zones = new Map<number, Obj>();
  let counters = new Map<number, number>();
  let life: [number, number] = [20, 20];
  let turn = { n: 0, a: 0 as 0 | 1, s: 'Upkeep' };
  let lastKey = '';
  let attacking = new Set<number>();
  let blocking = new Set<number>();
  let pendingCan: number[] | null = null;

  const side = (s: number | undefined | null): 0 | 1 => (s === seat ? 0 : 1);
  const zoneOf = (type: string, owner: number | null) => [...zones.values()].find((z) => z.type === type && (owner === null || z.ownerSeatId === owner));
  const idsIn = (z: Obj | undefined): number[] => (z?.objectInstanceIds ?? []) as number[];

  const robj = (id: number): RObj | null => {
    const o = objects.get(id);
    if (!o) return null;
    const types: string[] = o.cardTypes ?? [];
    let f = 0;
    if (o.isTapped) f |= FLAG.tapped;
    if (o.attackState === 'AttackState_Attacking' || o.attackState === 'AttackState_Declared') f |= FLAG.attacking;
    if (o.blockState === 'BlockState_Blocking' || o.blockState === 'BlockState_Declared') f |= FLAG.blocking;
    if (o.type === 'GameObjectType_Token') f |= FLAG.token;
    if (o.hasSummoningSickness) f |= FLAG.sick;
    if (o.type === 'GameObjectType_Ability') f |= FLAG.ability;
    if (types.includes('CardType_Land')) f |= FLAG.land;
    if (types.includes('CardType_Creature')) f |= FLAG.creature;
    const r: RObj = { i: id, g: o.grpId ?? 0, c: side(o.controllerSeatId ?? o.ownerSeatId) };
    if (f) r.f = f;
    if (o.power && types.includes('CardType_Creature')) {
      r.p = num(o.power.value) ?? 0;
      r.t = num(o.toughness?.value) ?? 0;
    }
    if (o.damage) r.d = o.damage;
    const k = counters.get(id);
    if (k) r.k = k;
    if (o.attackInfo?.targetId && f & FLAG.attacking) r.at = o.attackInfo.targetId;
    if (o.blockInfo?.attackerIds?.length && f & FLAG.blocking) r.bl = o.blockInfo.attackerIds;
    if (o.type === 'GameObjectType_Ability') r.src = o.objectSourceGrpId ?? 0;
    return r;
  };
  const grpsIn = (z: Obj | undefined) => idsIn(z).map((id) => objects.get(id)?.grpId).filter((g): g is number => typeof g === 'number' && g > 0);

  function frame(events: REvent[]) {
    if (!rep) return;
    const bf = idsIn(zoneOf('ZoneType_Battlefield', null)).map(robj).filter((x): x is RObj => !!x);
    const stack = idsIn(zoneOf('ZoneType_Stack', null)).map(robj).filter((x): x is RObj => !!x);
    const exile = zoneOf('ZoneType_Exile', null);
    const exIds = idsIn(exile);
    const f: RFrame = {
      n: turn.n, a: turn.a, s: turn.s, l: [...life],
      bf, h: grpsIn(zoneOf('ZoneType_Hand', seat)), oh: idsIn(zoneOf('ZoneType_Hand', seat === 1 ? 2 : 1)).length,
      gy: [grpsIn(zoneOf('ZoneType_Graveyard', seat)), grpsIn(zoneOf('ZoneType_Graveyard', seat === 1 ? 2 : 1))],
      ex: [
        exIds.filter((id) => objects.get(id)?.ownerSeatId === seat).map((id) => objects.get(id)?.grpId ?? 0).filter(Boolean),
        exIds.filter((id) => objects.get(id) && objects.get(id)!.ownerSeatId !== seat).map((id) => objects.get(id)?.grpId ?? 0).filter(Boolean),
      ],
      sk: stack,
      lib: [idsIn(zoneOf('ZoneType_Library', seat)).length, idsIn(zoneOf('ZoneType_Library', seat === 1 ? 2 : 1)).length],
      e: events,
    };
    // Skip a frame that changes nothing (same board, nothing happened).
    const key = JSON.stringify([f.n, f.a, f.s, f.l, f.bf, f.h, f.oh, f.gy, f.ex, f.sk]);
    if (!events.length && key === lastKey) return;
    lastKey = key;
    if (pendingCan) {
      f.can = pendingCan;
      pendingCan = null;
    }
    rep.frames.push(f);
  }

  for (const raw of text.split('\n')) {
    if (!raw.includes('"greToClientEvent"')) continue;
    const at = raw.indexOf('{');
    if (at < 0) continue;
    let msg: Obj;
    try {
      msg = JSON.parse(raw.slice(at));
    } catch {
      continue;
    }
    for (const m of (msg.greToClientEvent?.greToClientMessages ?? []) as Obj[]) {
      if (m.type === 'GREMessageType_ConnectResp') {
        seat = m.systemSeatIds?.[0] ?? seat;
        continue;
      }
      if (m.type === 'GREMessageType_ActionsAvailableReq' && rep && (m.systemSeatIds ?? []).includes(seat)) {
        const can = ((m.actionsAvailableReq?.actions ?? []) as Obj[])
          .filter((a) => a.actionType === 'ActionType_Cast' || a.actionType === 'ActionType_Play')
          .map((a) => a.grpId)
          .filter((g): g is number => typeof g === 'number' && g > 0);
        pendingCan = [...new Set(can)];
        continue;
      }
      if (m.type === 'GREMessageType_MulliganReq' && rep && (m.systemSeatIds ?? []).includes(seat)) {
        frame([{ k: 'mulligan', w: 0, n: grpsIn(zoneOf('ZoneType_Hand', seat)).length }]);
        continue;
      }
      const gs = m.gameStateMessage as Obj | undefined;
      if (!gs) continue;
      const info = gs.gameInfo;
      if (info?.matchID && typeof info.gameNumber === 'number') {
        const id = `${info.matchID}-${info.gameNumber}`;
        if (!rep || rep.id !== id) {
          rep = out.get(id) ?? { v: REPLAY_VERSION, id, seat, frames: [] };
          rep.frames = [];
          rep.seat = seat;
          out.set(id, rep);
          objects = new Map();
          zones = new Map();
          counters = new Map();
          life = [20, 20];
          turn = { n: 0, a: 0, s: 'Upkeep' };
          lastKey = '';
          attacking = new Set();
          blocking = new Set();
          pendingCan = null;
        }
      }
      if (!rep) continue;
      if (gs.type === 'GameStateType_Full') {
        objects = new Map();
        zones = new Map();
      }
      for (const z of (gs.zones ?? []) as Obj[]) zones.set(z.zoneId, z);
      for (const o of (gs.gameObjects ?? []) as Obj[]) objects.set(o.instanceId, o);
      for (const id of (gs.diffDeletedInstanceIds ?? []) as number[]) objects.delete(id);
      for (const p of (gs.players ?? []) as Obj[]) {
        if (typeof p.lifeTotal === 'number') life[side(p.systemSeatNumber)] = p.lifeTotal;
      }
      let stepChanged = false;
      const ti = gs.turnInfo;
      if (ti) {
        const n = num(ti.turnNumber) ?? turn.n;
        const a = ti.activePlayer ? side(ti.activePlayer) : turn.a;
        const s = (ti.step && STEP[ti.step]) || (ti.phase && PHASE[ti.phase]) || turn.s;
        if (n !== turn.n || a !== turn.a || s !== turn.s) stepChanged = true;
        turn = { n, a, s };
      }

      // What happened, from Arena's annotations.
      const events: REvent[] = [];
      const grpOf = (id: number) => objects.get(id)?.grpId ?? 0;
      const whoOf = (id: number): 0 | 1 => side(objects.get(id)?.controllerSeatId ?? objects.get(id)?.ownerSeatId);
      const target = (id: number): number | string => (id === 1 || id === 2 ? `p${side(id)}` : grpOf(id));
      for (const a of (gs.annotations ?? []) as Obj[]) {
        const types: string[] = a.type ?? [];
        if (types.includes('AnnotationType_ObjectIdChanged')) {
          const from = num(detail(a, 'orig_id')[0]);
          const to = num(detail(a, 'new_id')[0]);
          if (from !== null && to !== null && counters.has(from)) {
            counters.set(to, counters.get(from)!);
            counters.delete(from);
          }
        }
        if (types.includes('AnnotationType_ZoneTransfer')) {
          const cat = String(detail(a, 'category')[0] ?? '');
          const dest = zones.get(Number(detail(a, 'zone_dest')[0]))?.type ?? '';
          for (const id of (a.affectedIds ?? []) as number[]) {
            const o = objects.get(id);
            if (!o || o.type === 'GameObjectType_Ability') continue;
            const w = side(o.ownerSeatId);
            const g = o.grpId ?? 0;
            if (cat === 'Resolve') continue;
            if (cat === 'PlayLand') events.push({ k: 'land', w: whoOf(id), g });
            else if (cat === 'CastSpell') events.push({ k: 'cast', w: whoOf(id), g });
            else if (cat === 'Draw') events.push({ k: 'draw', w, g: w === 0 ? g : 0 });
            else if (cat.startsWith('SBA_')) events.push({ k: 'dies', w, g, r: cat.replace('SBA_', '') });
            else if (cat === 'Destroy') events.push({ k: 'destroyed', w, g });
            else if (cat === 'Sacrifice') events.push({ k: 'sacrificed', w, g });
            else if (cat === 'Discard') events.push({ k: 'discarded', w, g });
            else if (cat === 'Exile') events.push({ k: 'exiled', w, g });
            else if (cat === 'Mill') events.push({ k: 'milled', w, g });
            else if (cat === 'Surveil') events.push({ k: 'surveiled', w, g, z: dest.replace('ZoneType_', '') });
            else if (cat === 'Countered') events.push({ k: 'countered', w, g });
            else if (cat === 'Return') events.push({ k: 'returned', w, g, z: dest.replace('ZoneType_', '') });
            else if (cat === 'Put') events.push({ k: 'put', w, g, z: dest.replace('ZoneType_', '') });
            else events.push({ k: 'moved', w, g, z: dest.replace('ZoneType_', ''), r: cat });
          }
        }
        if (types.includes('AnnotationType_DamageDealt')) {
          const n = num(detail(a, 'damage')[0]) ?? 0;
          for (const id of (a.affectedIds ?? []) as number[]) events.push({ k: 'damage', w: whoOf(a.affectorId), g: grpOf(a.affectorId), n, to: target(id) });
        }
        if (types.includes('AnnotationType_ModifiedLife')) {
          const n = num(detail(a, 'life')[0]) ?? 0;
          for (const id of (a.affectedIds ?? []) as number[]) if (id === 1 || id === 2) events.push({ k: 'life', w: side(id), n });
        }
        if (types.includes('AnnotationType_TargetSpec') && a.affectorId) {
          const src = objects.get(a.affectorId);
          const g = src?.type === 'GameObjectType_Ability' ? (src.objectSourceGrpId ?? 0) : (src?.grpId ?? 0);
          for (const id of (a.affectedIds ?? []) as number[]) events.push({ k: 'target', w: whoOf(a.affectorId), g, to: target(id) });
        }
        if (types.includes('AnnotationType_TokenCreated')) {
          for (const id of (a.affectedIds ?? []) as number[]) events.push({ k: 'token', w: whoOf(id), g: grpOf(id) });
        }
        if (types.includes('AnnotationType_CounterAdded') || types.includes('AnnotationType_CounterRemoved')) {
          const n = (num(detail(a, 'transaction_amount')[0]) ?? 1) * (types.includes('AnnotationType_CounterRemoved') ? -1 : 1);
          for (const id of (a.affectedIds ?? []) as number[]) {
            counters.set(id, Math.max(0, (counters.get(id) ?? 0) + n));
            if (n > 0) events.push({ k: 'counter', w: whoOf(id), g: grpOf(id), n });
          }
        }
      }
      // Attacks and blocks: new attackers and blockers since the last message.
      const nowAttacking = new Set<number>();
      const nowBlocking = new Set<number>();
      for (const [id, o] of objects) {
        if (o.attackState === 'AttackState_Attacking' || o.attackState === 'AttackState_Declared') nowAttacking.add(id);
        if (o.blockState === 'BlockState_Blocking' || o.blockState === 'BlockState_Declared') nowBlocking.add(id);
      }
      for (const id of nowAttacking) if (!attacking.has(id)) events.push({ k: 'attack', w: whoOf(id), g: grpOf(id), to: target(objects.get(id)?.attackInfo?.targetId ?? 0) });
      for (const id of nowBlocking) {
        if (blocking.has(id)) continue;
        const atk = objects.get(id)?.blockInfo?.attackerIds?.[0];
        events.push({ k: 'block', w: whoOf(id), g: grpOf(id), to: atk ? grpOf(atk) : 0 });
      }
      attacking = nowAttacking;
      blocking = nowBlocking;

      if (info?.stage === 'GameStage_GameOver' && Array.isArray(info.results)) {
        const r = (info.results as Obj[]).find((x) => x.scope === 'MatchScope_Game') ?? info.results[0];
        const players = (gs.players ?? []) as Obj[];
        const mine = players.find((p) => p.systemSeatNumber === seat)?.teamId ?? seat;
        if (!rep.frames.some((f) => f.e.some((e) => e.k === 'result'))) {
          events.push({ k: 'result', w: r?.result === 'ResultType_Draw' ? undefined : r?.winningTeamId === mine ? 0 : 1, r: String(r?.reason ?? '').replace('ResultReason_', '') });
        }
      }
      if (events.length || stepChanged) frame(events);
    }
  }
  // Games that never started play (lobby glitches) leave no frames.
  for (const [id, r] of out) if (r.frames.length < 3) out.delete(id);
  return out;
}

/** Every card id a replay shows (to name them). */
export function replayIds(r: Replay): number[] {
  const ids = new Set<number>();
  for (const f of r.frames) {
    for (const o of [...f.bf, ...f.sk]) {
      if (o.g) ids.add(o.g);
      if (o.src) ids.add(o.src);
    }
    for (const g of [...f.h, ...f.gy[0], ...f.gy[1], ...f.ex[0], ...f.ex[1], ...(f.can ?? [])]) ids.add(g);
    for (const e of f.e) {
      if (e.g) ids.add(e.g);
      if (typeof e.to === 'number' && e.to) ids.add(e.to);
    }
  }
  return [...ids];
}
