// Real Arena drafts and games, read from Player.log, as records the 24spells site
// can review (2026-11-13: "log real games on 24spells"). Log reading only:
// the same file the stats overlay follows. Pure: text in, records out, so it
// runs on the live log, the previous log, and every archived copy alike.
//
// Arena replaces Player.log at every launch, so the app re-reads the log after
// each draft and game and saves the records; ids are stable, so reading the same
// log twice gives the same records.
//
// What leaves the PC (see main.mjs): card ids, picks, the deck, and what happened
// each turn. Never player names or account ids: the parser does not keep them.

export type ArenaPick = { pack: number; pick: number; shown: number[]; taken: number | null };

export type ArenaDraftRecord = {
  kind: 'draft';
  /** The Arena course (one paid entry: the draft plus its matches), else the draft id. */
  id: string;
  course: string | null;
  draftId: string;
  event: string | null;
  set: string | null;
  format: string | null;
  at: number | null;
  picks: ArenaPick[];
  /** Arena's own record for the course, when the log shows it. */
  wins: number | null;
  losses: number | null;
};

export type ArenaTurn = {
  n: number;
  /** Whose turn: your seat's or the opponent's. */
  me: boolean;
  drew: number[];
  /** Cards put into your hand another way: searched for, returned, and so on. */
  toHand: number[];
  land: number | null;
  cast: number[];
  oppCast: number[];
  /** At the end of the turn: [you, opponent]. */
  life: [number, number];
  lands: number;
  oppLands: number;
  hand: number;
};

export type ArenaGameRecord = {
  kind: 'game';
  id: string;
  matchId: string;
  game: number;
  course: string | null;
  event: string | null;
  at: number | null;
  ended: number | null;
  onPlay: boolean | null;
  result: 'win' | 'loss' | 'draw' | null;
  reason: string | null;
  deck: number[];
  side: number[];
  /** Every hand you were offered, in order; the last one is the one you kept (before bottoming). */
  hands: number[][];
  /** The hand you started turn 1 with (after any cards went to the bottom). */
  kept: number[];
  turns: ArenaTurn[];
  oppSeen: number[];
  /** Your cards still in hand when the game ended. */
  stuck: number[];
  /** Your Arena Limited rank when the game started (from the last rank Arena logged), for 24spells. */
  rank?: ArenaRank | null;
};

/** Arena's Limited rank: class (Bronze ... Mythic), tier 1-4, Mythic percentile or place, season. */
export type ArenaRank = { cls: string; level: number | null; pct: number | null; place: number | null; season: number | null };

/**
 * A sealed (or traditional sealed) pool (2026-11-14: "a single push button to export the pool into
 * the web client"). Arena lists each event you are in with its CardPool; for sealed, that is the
 * opened pool. Read straight from the log on demand, not sent to 24spells.
 */
export type ArenaSealedPool = {
  kind: 'sealed';
  id: string;
  course: string;
  event: string;
  set: string;
  format: string;
  at: number | null;
  pool: number[];
  wins: number | null;
  losses: number | null;
};

export type ArenaRecords = {
  drafts: ArenaDraftRecord[];
  sealed: ArenaSealedPool[];
  games: ArenaGameRecord[];
  /** Basic lands named from the game itself (17Lands' card list can miss them). */
  basics: Record<string, string>;
};

type Obj = { grpId: number; owner: number; controller: number; zone: number; land: boolean; card: boolean; basic: string | null };
type Zone = { type: string; owner: number | null; ids: number[] };

const DRAFT_EVENT = /\b((?:PremierDraft|QuickDraft|TraditionalDraft|CubeDraft|Sealed|TraditionalSealed)_([A-Za-z0-9]+)_\d{8})\b/;
// Arena's header times: "...PM: Match to ..." lines are local time, bare ones are UTC.
const HEADER_TIME = /^\[UnityCrossThreadLogger\](\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2}(?: [AP]M)?)(:?)/;
const SEALED_EVENT = /\b(Sealed|TraditionalSealed|TradSealed)_([A-Za-z0-9]+)_\d{8}\b/;
const COURSE = /"CourseId":"([0-9a-f-]{36})","InternalEventName":"([^"]+)"/g;
const BASIC_TYPES: Record<string, string> = { SubType_Plains: 'Plains', SubType_Island: 'Island', SubType_Swamp: 'Swamp', SubType_Mountain: 'Mountain', SubType_Forest: 'Forest' };

function jsonFrom(line: string, from = 0): Record<string, unknown> | null {
  const start = line.indexOf('{', from);
  if (start < 0) return null;
  try {
    return JSON.parse(line.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

export function readArenaLog(text: string): ArenaRecords {
  const drafts = new Map<string, ArenaDraftRecord>();
  const sealed = new Map<string, ArenaSealedPool>();
  const games = new Map<string, ArenaGameRecord>();
  const basics: Record<string, string> = {};
  /** Latest course per event name, and each course's Arena record. */
  const courseOf = new Map<string, string>();
  const courseRecord = new Map<string, { wins: number | null; losses: number | null }>();
  const eventOfMatch = new Map<string, string>();
  let now: number | null = null;
  let draft: ArenaDraftRecord | null = null;
  let pending: { pack: number; pick: number; shown: number[] } | null = null;
  let joined: { event: string; set: string; format: string } | null = null;
  /** The latest Limited rank Arena logged (RankGetCombinedRankInfo, at login and after events). */
  let rank: ArenaRank | null = null;
  /** Games that started before this log showed any rank: they take the first rank logged after them. */
  let unranked: ArenaGameRecord[] = [];

  // The game in progress.
  let seat = 0;
  let deck: number[] = [];
  let side: number[] = [];
  let g: ArenaGameRecord | null = null;
  let team = new Map<number, number>();
  let objects = new Map<number, Obj>();
  let zones = new Map<number, Zone>();
  let life: [number, number] = [20, 20];
  let turn: ArenaTurn | null = null;

  const handOf = (s: number) => [...zones.values()].find((z) => z.type === 'ZoneType_Hand' && z.owner === s)?.ids ?? [];
  const grp = (ids: number[]) => ids.map((i) => objects.get(i)?.grpId).filter((x): x is number => typeof x === 'number' && x > 0);
  const landsOf = (s: number) => {
    const bf = [...zones.values()].find((z) => z.type === 'ZoneType_Battlefield');
    return (bf?.ids ?? []).filter((i) => {
      const o = objects.get(i);
      return o?.land && o.controller === s;
    }).length;
  };
  const closeTurn = () => {
    if (!turn || !g) return;
    turn.life = [...life];
    turn.lands = landsOf(seat);
    turn.oppLands = landsOf(3 - seat);
    turn.hand = handOf(seat).length;
  };

  const finishDraftPick = (taken: number | null) => {
    if (draft && pending) {
      draft.picks.push({ ...pending, taken });
      pending = null;
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const head = HEADER_TIME.exec(line);
    if (head) {
      const t = Date.parse(head[2] ? head[1] : `${head[1]} UTC`);
      if (Number.isFinite(t)) now = t;
    }
    // Your rank (2026-11-15, for 24spells titles): the response to RankGetCombinedRankInfo is one
    // JSON line with limitedClass, limitedLevel and, at Mythic, a percentile or leaderboard place.
    if (line.startsWith('{') && line.includes('"limitedClass"')) {
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        if (typeof r.limitedClass === 'string') {
          rank = { cls: r.limitedClass, level: n(r.limitedLevel), pct: n(r.limitedPercentile), place: n(r.limitedLeaderboardPlace), season: n(r.limitedSeasonOrdinal) };
          for (const old of unranked) old.rank = rank;
          unranked = [];
        }
      } catch {
        // A cut-off line: keep the last good rank.
      }
      continue;
    }
    // Courses: Arena repeats each course (id, event, record) in several responses.
    if (line.includes('"CourseId"')) {
      for (const m of line.matchAll(COURSE)) {
        courseOf.set(m[2], m[1]);
        const tail = line.slice(m.index ?? 0, (m.index ?? 0) + 4000);
        const next = tail.indexOf('"CourseId"', 12);
        const body = next > 0 ? tail.slice(0, next) : tail;
        const w = /"CurrentWins":(\d+)/.exec(body);
        const l = /"CurrentLosses":(\d+)/.exec(body);
        if (w || l) // Arena leaves out a zero count.
        courseRecord.set(m[1], { wins: w ? Number(w[1]) : 0, losses: l ? Number(l[1]) : 0 });
      }
    }

    // Sealed pools: any course object of a sealed event with its card pool.
    if (line.includes('"CardPool":[') && /Sealed_/.test(line)) {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (!v || typeof v !== 'object') return;
        const o = v as Record<string, unknown>;
        const ev = typeof o.InternalEventName === 'string' ? SEALED_EVENT.exec(o.InternalEventName) : null;
        if (ev && typeof o.CourseId === 'string' && Array.isArray(o.CardPool)) {
          const pool = (o.CardPool as unknown[]).map(num).filter((x): x is number => x !== null && x > 0);
          if (pool.length >= 40) {
            const prev = sealed.get(o.CourseId);
            sealed.set(o.CourseId, {
              kind: 'sealed', id: o.CourseId, course: o.CourseId, event: ev[0], set: ev[2].toUpperCase(), format: ev[1],
              at: prev?.at ?? now, pool, wins: num(o.CurrentWins) ?? 0, losses: num(o.CurrentLosses) ?? 0,
            });
          }
        }
        for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x);
      };
      walk(jsonFrom(line));
    }

    // ---------- Drafts ----------
    if (line.includes('==> EventJoin') || line.includes('==> Event_Join')) {
      const m = DRAFT_EVENT.exec(line.replace(/\\"/g, '"'));
      if (m) joined = { event: m[1], set: m[2], format: m[1].split('_')[0] };
    }
    const notify = line.indexOf('Draft.Notify');
    if (notify >= 0) {
      const msg = jsonFrom(line, notify);
      const pack = num(msg?.SelfPack);
      const pick = num(msg?.SelfPick);
      const cards = typeof msg?.PackCards === 'string' ? msg.PackCards.split(',').map(Number).filter(Number.isFinite) : null;
      const draftId = typeof msg?.draftId === 'string' ? msg.draftId : null;
      if (pack !== null && pick !== null && cards && draftId) {
        if (!draft || draft.draftId !== draftId) {
          const course = joined ? courseOf.get(joined.event) ?? null : null;
          const id = course ?? draftId;
          draft = drafts.get(id) ?? {
            kind: 'draft', id, course, draftId, event: joined?.event ?? null, set: joined?.set ?? null, format: joined?.format ?? null,
            at: now, picks: [], wins: null, losses: null,
          };
          // Re-reading the same draft (a second log copy): start its picks over.
          draft.picks = [];
          drafts.set(id, draft);
        }
        pending = { pack, pick, shown: cards };
      }
      continue;
    }
    if (line.includes('==> EventPlayerDraftMakePick') || line.includes('==> Event_PlayerDraftMakePick')) {
      const req = jsonFrom(line);
      let inner: Record<string, unknown> | null = null;
      try {
        inner = typeof req?.request === 'string' ? (JSON.parse(req.request) as Record<string, unknown>) : null;
      } catch {
        inner = null;
      }
      const ids = Array.isArray(inner?.GrpIds) ? (inner.GrpIds as unknown[]).map(num) : [num(inner?.GrpId)];
      finishDraftPick(ids.find((x): x is number => x !== null) ?? null);
      continue;
    }

    // ---------- Matches ----------
    if (line.includes('"matchGameRoomStateChangedEvent"')) {
      const msg = jsonFrom(line);
      const room = (msg?.matchGameRoomStateChangedEvent as Record<string, any> | undefined)?.gameRoomInfo;
      const matchId = room?.gameRoomConfig?.matchId;
      const players = room?.gameRoomConfig?.reservedPlayers;
      if (typeof matchId === 'string' && Array.isArray(players)) {
        const ev = players.map((p: Record<string, unknown>) => p.eventId).find((e: unknown) => typeof e === 'string');
        if (typeof ev === 'string') eventOfMatch.set(matchId, ev);
      }
      continue;
    }
    if (!line.includes('"greToClientEvent"')) continue;
    const msg = jsonFrom(line);
    const ts = num(msg?.timestamp);
    if (ts) now = ts;
    const list = (msg?.greToClientEvent as { greToClientMessages?: Record<string, any>[] } | undefined)?.greToClientMessages ?? [];
    for (const m of list) {
      if (m.type === 'GREMessageType_ConnectResp') {
        seat = m.systemSeatIds?.[0] ?? seat;
        deck = (m.connectResp?.deckMessage?.deckCards ?? []).filter((x: unknown) => typeof x === 'number');
        side = (m.connectResp?.deckMessage?.sideboardCards ?? []).filter((x: unknown) => typeof x === 'number');
        continue;
      }
      if (m.type === 'GREMessageType_MulliganReq' && g && (m.systemSeatIds ?? []).includes(seat)) {
        g.hands.push(grp(handOf(seat)));
        continue;
      }
      const gs = m.gameStateMessage;
      if (!gs) continue;
      const info = gs.gameInfo;
      if (info?.matchID && typeof info.gameNumber === 'number') {
        const id = `${info.matchID}-${info.gameNumber}`;
        if (!g || g.id !== id) {
          if (g && turn) closeTurn();
          const event = eventOfMatch.get(info.matchID) ?? null;
          g = {
            kind: 'game', id, matchId: info.matchID, game: info.gameNumber, course: event ? courseOf.get(event) ?? null : null, event,
            at: now, ended: null, onPlay: null, result: null, reason: null, deck: [...deck], side: [...side],
            hands: [], kept: [], turns: [], oppSeen: [], stuck: [], rank,
          };
          games.set(id, g);
          if (!rank) unranked.push(g);
          objects = new Map();
          zones = new Map();
          team = new Map();
          life = [20, 20];
          turn = null;
        }
      }
      if (!g) continue;
      if (!g.event && eventOfMatch.has(g.matchId)) {
        g.event = eventOfMatch.get(g.matchId) ?? null;
        g.course = g.event ? courseOf.get(g.event) ?? null : null;
      }
      for (const p of gs.players ?? []) {
        if (typeof p.teamId === 'number') team.set(p.systemSeatNumber, p.teamId);
        if (typeof p.lifeTotal === 'number') life[p.systemSeatNumber === seat ? 0 : 1] = p.lifeTotal;
      }
      for (const z of gs.zones ?? []) {
        zones.set(z.zoneId, { type: z.type, owner: z.ownerSeatId ?? null, ids: z.objectInstanceIds ?? [] });
      }
      for (const o of gs.gameObjects ?? []) {
        const types: string[] = o.cardTypes ?? [];
        const basicSub = (o.superTypes ?? []).includes('SuperType_Basic') ? (o.subtypes ?? []).map((s: string) => BASIC_TYPES[s]).find(Boolean) ?? null : null;
        objects.set(o.instanceId, {
          grpId: o.grpId, owner: o.ownerSeatId, controller: o.controllerSeatId ?? o.ownerSeatId, zone: o.zoneId,
          land: types.includes('CardType_Land'), card: o.type === 'GameObjectType_Card', basic: basicSub,
        });
        if (basicSub && o.grpId) basics[String(o.grpId)] = basicSub;
        const zt = zones.get(o.zoneId)?.type;
        if (o.ownerSeatId !== seat && o.type === 'GameObjectType_Card' && o.grpId && zt && !['ZoneType_Library', 'ZoneType_Hand', 'ZoneType_Limbo'].includes(zt) && !g.oppSeen.includes(o.grpId)) {
          g.oppSeen.push(o.grpId);
        }
      }
      for (const id of gs.diffDeletedInstanceIds ?? []) objects.delete(id);
      const ti = gs.turnInfo;
      if (typeof ti?.turnNumber === 'number' && ti.turnNumber > (turn?.n ?? 0)) {
        if (turn) closeTurn();
        if (ti.turnNumber === 1 || g.onPlay === null) g.onPlay = g.onPlay ?? (ti.turnNumber === 1 ? ti.activePlayer === seat : null);
        if (!g.kept.length) g.kept = grp(handOf(seat));
        turn = { n: ti.turnNumber, me: ti.activePlayer === seat, drew: [], toHand: [], land: null, cast: [], oppCast: [], life: [...life], lands: 0, oppLands: 0, hand: 0 };
        g.turns.push(turn);
      }
      for (const a of gs.annotations ?? []) {
        if (!(a.type ?? []).includes('AnnotationType_ZoneTransfer') || !turn) continue;
        const cat = (a.details ?? []).find((d: Record<string, any>) => d.key === 'category')?.valueString?.[0];
        const dest = (a.details ?? []).find((d: Record<string, any>) => d.key === 'zone_dest')?.valueInt32?.[0];
        const src = (a.details ?? []).find((d: Record<string, any>) => d.key === 'zone_src')?.valueInt32?.[0];
        const toMyHand = (z: number | undefined) => z !== undefined && zones.get(z)?.type === 'ZoneType_Hand' && zones.get(z)?.owner === seat;
        for (const id of a.affectedIds ?? []) {
          const o = objects.get(id);
          if (!o?.grpId || !o.card) continue;
          const mine = o.controller === seat;
          if (cat === 'PlayLand' && mine) turn.land = o.grpId;
          else if (cat === 'CastSpell') (mine ? turn.cast : turn.oppCast).push(o.grpId);
          else if (cat === 'Draw' && o.owner === seat) turn.drew.push(o.grpId);
          else if (toMyHand(dest) && !toMyHand(src)) turn.toHand.push(o.grpId);
        }
      }
      if (info?.stage === 'GameStage_GameOver' && Array.isArray(info.results) && g.result === null) {
        const r = info.results.find((x: Record<string, unknown>) => x.scope === 'MatchScope_Game') ?? info.results[0];
        const mineTeam = team.get(seat) ?? seat;
        g.result = r?.result === 'ResultType_Draw' ? 'draw' : r?.winningTeamId === mineTeam ? 'win' : 'loss';
        g.reason = typeof r?.reason === 'string' ? r.reason.replace('ResultReason_', '') : null;
        g.ended = now;
        closeTurn();
        g.stuck = grp(handOf(seat));
      }
    }
  }

  for (const d of drafts.values()) {
    const r = d.course ? courseRecord.get(d.course) : undefined;
    if (r) {
      d.wins = r.wins;
      d.losses = r.losses;
    }
  }
  return { drafts: [...drafts.values()], sealed: [...sealed.values()], games: [...games.values()], basics };
}
