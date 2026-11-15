// Full game replays (Ken 2026-11-15: "a full fledged action by action viewer ... full richness of
// playback to recreate the whole thing perfectly to study"; the first step toward chess.com-style
// review, no scoring yet).
//
// A separate pass over Player.log (arena-records.ts keeps its own simpler per-turn summary). Arena's
// game engine sends the game as a stream of state messages: changed objects (cards, tokens,
// abilities), zones, life, the turn and step, and annotations for everything that happened (a card
// moved and why, damage, life, targets, counters, tokens, abilities). This keeps the board up to
// date message by message and saves a FRAME whenever something happened or the step changed.
//
// Version 2: every card is named by its INSTANCE (the exact copy on the table), and every event says
// which instances: the card that moved and the id it had before (a card gets a new id each time it
// changes zone), the zones it moved between, the source and target of damage, targets, attacks and
// blocks. That is what lets the viewer fly a card from your hand to the stack to the battlefield,
// draw arrows from a spell to its target, and so on. Hands, graveyards and exile carry instances too;
// the opponent's hand is instances with no card (Arena hides them).
//
// What it cannot show: the opponent's hand contents and library order. Also kept: the cards you could
// cast or play whenever Arena asked you to act (for the decision review later; not shown yet).
//
// Pure: log text in, replays out. Card ids and game events only, never player names or account ids.

export const REPLAY_VERSION = 2;

/** One object on the board or stack. c: 0 yours, 1 the opponent's. f: flags (FLAG). */
export type RObj = { i: number; g: number; c: 0 | 1; f?: number; p?: number; t?: number; d?: number; k?: number; at?: number; bl?: number[]; src?: number; si?: number };
export const FLAG = { tapped: 1, attacking: 2, blocking: 4, token: 8, sick: 16, ability: 32, land: 64, creature: 128 } as const;
/** A card in a hand, graveyard or exile: [instance, card id]. */
export type RCard = [number, number];
/** A target: an instance, or "p0" / "p1" for a player (you / the opponent). */
export type RTarget = number | 'p0' | 'p1';

/**
 * What happened. w: 0 you, 1 the opponent. g: the card (grpId). i: the instance it concerns; fi: its
 * instance before it moved; fz / tz: from and to zone. si / ti: source and target instances.
 * to: the target's card id (or "p0"/"p1"), for the words.
 */
export type REvent = {
  k:
    | 'land' | 'cast' | 'resolve' | 'draw' | 'dies' | 'destroyed' | 'sacrificed' | 'discarded' | 'exiled' | 'milled'
    | 'surveiled' | 'countered' | 'returned' | 'put' | 'moved' | 'damage' | 'life' | 'target' | 'token' | 'counter'
    | 'ability' | 'attack' | 'block' | 'mulligan' | 'result';
  w?: 0 | 1;
  g?: number;
  n?: number;
  to?: number | string;
  z?: string;
  r?: string;
  i?: number;
  fi?: number;
  fz?: string;
  tz?: string;
  si?: number;
  ti?: RTarget;
};

export type RFrame = {
  /** Turn number and whose turn (0 yours, 1 the opponent's). */
  n: number;
  a: 0 | 1;
  /** Step: Untap, Upkeep, Draw, Main1, BeginCombat, DeclareAttack, DeclareBlock, FirstStrike, Damage, EndCombat, Main2, End, Cleanup. */
  s: string;
  /** Life: [you, opponent]. */
  l: [number, number];
  /** Battlefield, in Arena's order. */
  bf: RObj[];
  /** Your hand; the opponent's hand (instances only). */
  h: RCard[];
  oh: number[];
  /** Graveyards and exiles: [yours, theirs], oldest first. */
  gy: [RCard[], RCard[]];
  ex: [RCard[], RCard[]];
  /** The stack, top first. */
  sk: RObj[];
  /** Library sizes: [yours, theirs]. */
  lib: [number, number];
  /** What happened since the last frame, in order. */
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
  Step_Untap: 'Untap', Step_Upkeep: 'Upkeep', Step_Draw: 'Draw', Step_BeginCombat: 'BeginCombat', Step_DeclareAttack: 'DeclareAttack',
  Step_DeclareBlock: 'DeclareBlock', Step_CombatDamage: 'Damage', Step_FirstStrikeDamage: 'FirstStrike', Step_EndCombat: 'EndCombat',
  Step_End: 'End', Step_Cleanup: 'Cleanup',
};
const PHASE: Record<string, string> = { Phase_Main1: 'Main1', Phase_Main2: 'Main2', Phase_Beginning: 'Upkeep', Phase_Combat: 'BeginCombat', Phase_Ending: 'End' };
const ZONE = (t: string | undefined) => (t ?? '').replace('ZoneType_', '');

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
  const oppSeat = () => (seat === 1 ? 2 : 1);
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
    if (o.type === 'GameObjectType_Ability') {
      r.src = o.objectSourceGrpId ?? 0;
      if (o.parentId) r.si = o.parentId;
    }
    return r;
  };
  const cardsIn = (z: Obj | undefined): RCard[] =>
    idsIn(z).map((id): RCard => [id, objects.get(id)?.grpId ?? 0]).filter(([, g]) => g > 0);

  function frame(events: REvent[]) {
    if (!rep) return;
    const bf = idsIn(zoneOf('ZoneType_Battlefield', null)).map(robj).filter((x): x is RObj => !!x);
    const stack = idsIn(zoneOf('ZoneType_Stack', null)).map(robj).filter((x): x is RObj => !!x);
    const exIds = idsIn(zoneOf('ZoneType_Exile', null));
    const exOf = (mine: boolean): RCard[] =>
      exIds.filter((id) => objects.has(id) && (objects.get(id)!.ownerSeatId === seat) === mine).map((id): RCard => [id, objects.get(id)!.grpId ?? 0]).filter(([, g]) => g > 0);
    const f: RFrame = {
      n: turn.n, a: turn.a, s: turn.s, l: [...life],
      bf, h: cardsIn(zoneOf('ZoneType_Hand', seat)), oh: idsIn(zoneOf('ZoneType_Hand', oppSeat())),
      gy: [cardsIn(zoneOf('ZoneType_Graveyard', seat)), cardsIn(zoneOf('ZoneType_Graveyard', oppSeat()))],
      ex: [exOf(true), exOf(false)],
      sk: stack,
      lib: [idsIn(zoneOf('ZoneType_Library', seat)).length, idsIn(zoneOf('ZoneType_Library', oppSeat())).length],
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
        frame([{ k: 'mulligan', w: 0, n: cardsIn(zoneOf('ZoneType_Hand', seat)).length }]);
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
      // Before this message changes anything: where each object was (for "from" zones).
      const zoneBefore = new Map<number, string>();
      for (const z of zones.values()) for (const id of idsIn(z)) zoneBefore.set(id, ZONE(z.type));
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

      const annotations = (gs.annotations ?? []) as Obj[];
      // A card gets a new instance id each time it changes zone: new id -> the id it had before.
      const prev = new Map<number, number>();
      for (const a of annotations) {
        if (!(a.type ?? []).includes('AnnotationType_ObjectIdChanged')) continue;
        const from = num(detail(a, 'orig_id')[0]);
        const to = num(detail(a, 'new_id')[0]);
        if (from === null || to === null) continue;
        prev.set(to, from);
        if (counters.has(from)) {
          counters.set(to, counters.get(from)!);
          counters.delete(from);
        }
      }

      // What happened, from Arena's annotations, in Arena's order.
      const events: REvent[] = [];
      const grpOf = (id: number) => {
        const o = objects.get(id);
        return o?.type === 'GameObjectType_Ability' ? (o.objectSourceGrpId ?? 0) : (o?.grpId ?? 0);
      };
      const whoOf = (id: number): 0 | 1 => side(objects.get(id)?.controllerSeatId ?? objects.get(id)?.ownerSeatId);
      const tgt = (id: number): RTarget => (id === 1 || id === 2 ? (`p${side(id)}` as 'p0' | 'p1') : id);
      const words = (id: number): number | string => (id === 1 || id === 2 ? `p${side(id)}` : grpOf(id));
      for (const a of annotations) {
        const types: string[] = a.type ?? [];
        if (types.includes('AnnotationType_ZoneTransfer')) {
          const cat = String(detail(a, 'category')[0] ?? '');
          const tz = ZONE(zones.get(Number(detail(a, 'zone_dest')[0]))?.type);
          const fzNum = Number(detail(a, 'zone_src')[0]);
          for (const id of (a.affectedIds ?? []) as number[]) {
            const o = objects.get(id);
            const fi = prev.get(id) ?? id;
            const fz = ZONE(zones.get(fzNum)?.type) || zoneBefore.get(fi) || '';
            const base = { i: id, fi, fz, tz };
            // The opponent's hidden cards: only draws are worth showing (a card back moves to their hand).
            if (!o) {
              if (cat === 'Draw') events.push({ k: 'draw', w: 1, ...base });
              continue;
            }
            if (o.type === 'GameObjectType_Ability') continue;
            const w = side(o.ownerSeatId);
            const g = o.grpId ?? 0;
            if (cat === 'Resolve') events.push({ k: 'resolve', w: whoOf(id), g, ...base });
            else if (cat === 'PlayLand') events.push({ k: 'land', w: whoOf(id), g, ...base });
            else if (cat === 'CastSpell') events.push({ k: 'cast', w: whoOf(id), g, ...base });
            else if (cat === 'Draw') events.push({ k: 'draw', w, g: w === 0 ? g : 0, ...base });
            else if (cat.startsWith('SBA_')) events.push({ k: 'dies', w, g, r: cat.replace('SBA_', ''), ...base });
            else if (cat === 'Destroy') events.push({ k: 'destroyed', w, g, ...base });
            else if (cat === 'Sacrifice') events.push({ k: 'sacrificed', w, g, ...base });
            else if (cat === 'Discard') events.push({ k: 'discarded', w, g, ...base });
            else if (cat === 'Exile') events.push({ k: 'exiled', w, g, ...base });
            else if (cat === 'Mill') events.push({ k: 'milled', w, g, ...base });
            else if (cat === 'Surveil') events.push({ k: 'surveiled', w, g, z: tz, ...base });
            else if (cat === 'Countered') events.push({ k: 'countered', w, g, ...base });
            else if (cat === 'Return') events.push({ k: 'returned', w, g, z: tz, ...base });
            else if (cat === 'Put') events.push({ k: 'put', w, g, z: tz, ...base });
            else events.push({ k: 'moved', w, g, z: tz, r: cat, ...base });
          }
        }
        if (types.includes('AnnotationType_AbilityInstanceCreated') && a.affectorId) {
          for (const id of (a.affectedIds ?? []) as number[]) {
            const ab = objects.get(id);
            if (ab?.type !== 'GameObjectType_Ability') continue;
            // Only abilities that use the stack (triggers and activations), not mana abilities.
            if (zones.get(ab.zoneId)?.type !== 'ZoneType_Stack') continue;
            events.push({ k: 'ability', w: whoOf(a.affectorId), g: ab.objectSourceGrpId ?? grpOf(a.affectorId), i: id, si: a.affectorId });
          }
        }
        if (types.includes('AnnotationType_DamageDealt')) {
          const n = num(detail(a, 'damage')[0]) ?? 0;
          for (const id of (a.affectedIds ?? []) as number[]) events.push({ k: 'damage', w: whoOf(a.affectorId), g: grpOf(a.affectorId), n, to: words(id), si: a.affectorId, ti: tgt(id) });
        }
        if (types.includes('AnnotationType_ModifiedLife')) {
          const n = num(detail(a, 'life')[0]) ?? 0;
          for (const id of (a.affectedIds ?? []) as number[]) if (id === 1 || id === 2) events.push({ k: 'life', w: side(id), n, ti: tgt(id) });
        }
        if (types.includes('AnnotationType_TargetSpec') && a.affectorId) {
          for (const id of (a.affectedIds ?? []) as number[]) events.push({ k: 'target', w: whoOf(a.affectorId), g: grpOf(a.affectorId), to: words(id), si: a.affectorId, ti: tgt(id) });
        }
        if (types.includes('AnnotationType_TokenCreated')) {
          for (const id of (a.affectedIds ?? []) as number[]) events.push({ k: 'token', w: whoOf(id), g: grpOf(id), i: id, tz: 'Battlefield' });
        }
        if (types.includes('AnnotationType_CounterAdded') || types.includes('AnnotationType_CounterRemoved')) {
          const n = (num(detail(a, 'transaction_amount')[0]) ?? 1) * (types.includes('AnnotationType_CounterRemoved') ? -1 : 1);
          for (const id of (a.affectedIds ?? []) as number[]) {
            counters.set(id, Math.max(0, (counters.get(id) ?? 0) + n));
            if (n > 0) events.push({ k: 'counter', w: whoOf(id), g: grpOf(id), n, i: id });
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
      for (const id of nowAttacking) {
        if (attacking.has(id)) continue;
        const t = objects.get(id)?.attackInfo?.targetId ?? 0;
        events.push({ k: 'attack', w: whoOf(id), g: grpOf(id), to: words(t), i: id, ti: tgt(t) });
      }
      for (const id of nowBlocking) {
        if (blocking.has(id)) continue;
        const atk = objects.get(id)?.blockInfo?.attackerIds?.[0] ?? 0;
        events.push({ k: 'block', w: whoOf(id), g: grpOf(id), to: atk ? grpOf(atk) : 0, i: id, ti: atk });
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
    for (const [, g] of [...f.h, ...f.gy[0], ...f.gy[1], ...f.ex[0], ...f.ex[1]]) ids.add(g);
    for (const g of f.can ?? []) ids.add(g);
    for (const e of f.e) {
      if (e.g) ids.add(e.g);
      if (typeof e.to === 'number' && e.to) ids.add(e.to);
    }
  }
  return [...ids];
}
