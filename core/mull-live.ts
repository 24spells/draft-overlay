// Live: notice Arena's mulligan prompt and report the seven, the deck, play or draw, and the set.
// Fed one Player.log line at a time (log reading only). At GREMessageType_MulliganReq for your seat,
// turnInfo.activePlayer already names the player who takes turn 1 (checked: 30 of 30 saved games).

export type MullPrompt = {
  gameId: string;
  /** Set code from the event name (e.g. PremierDraft_TRK_20261101 -> TRK), or null. */
  set: string | null;
  hand: number[];
  deck: number[];
  onPlay: boolean;
  /** 1 = the first seven. The model only reads first sevens. */
  prompt: number;
  /**
   * Basic lands this log has shown (grpId -> W/U/B/R/G), from the cards' own types. Arena's newest basics
   * (e.g. 106895 Plains, Nov 2026) are in no card list yet, so the model alone counted them as unknown
   * spells: Ken's 3-land hand read as a 1-lander (2026-11-17).
   */
  basics: Record<string, string>;
};

const BASIC_COLOR: Record<string, string> = { SubType_Plains: 'W', SubType_Island: 'U', SubType_Swamp: 'B', SubType_Mountain: 'R', SubType_Forest: 'G' };

export type MullEvent = { kind: 'prompt'; data: MullPrompt } | { kind: 'clear' };

type Zone = { type: string; owner: number | null; ids: number[] };

function jsonFrom(line: string): Record<string, any> | null {
  const i = line.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(line.slice(i));
  } catch {
    return null;
  }
}

export function setFromEvent(event: string | null): string | null {
  if (!event) return null;
  const m = /(?:^|_)([A-Z0-9]{3,5})(?:_|$)/.exec(event.replace(/^(QuickDraft|PremierDraft|TradDraft|Sealed|TradSealed|CompDraft)_/, '_'));
  return m ? m[1] : null;
}

export function createMullWatcher(onEvent: (e: MullEvent) => void) {
  let seat: number | null = null;
  let deck: number[] = [];
  /** Kept across games: the same printing comes back game after game. */
  const basics: Record<string, string> = {};
  let active: number | null = null;
  let gameId: string | null = null;
  let prompts = 0;
  let showing = false;
  let zones = new Map<number, Zone>();
  let objects = new Map<number, number>();
  const eventOfMatch = new Map<string, string>();
  let matchId: string | null = null;

  const clear = () => {
    if (showing) {
      showing = false;
      onEvent({ kind: 'clear' });
    }
  };

  return function feed(line: string): void {
    if (line.includes('"matchGameRoomStateChangedEvent"')) {
      const room = jsonFrom(line)?.matchGameRoomStateChangedEvent?.gameRoomInfo;
      const id = room?.gameRoomConfig?.matchId;
      const ev = (room?.gameRoomConfig?.reservedPlayers ?? []).map((p: Record<string, unknown>) => p.eventId).find((e: unknown) => typeof e === 'string');
      if (typeof id === 'string' && typeof ev === 'string') eventOfMatch.set(id, ev);
      return;
    }
    if (!line.includes('"greToClientEvent"')) return;
    const list = (jsonFrom(line)?.greToClientEvent?.greToClientMessages ?? []) as Record<string, any>[];
    for (const m of list) {
      if (m.type === 'GREMessageType_ConnectResp') {
        seat = m.systemSeatIds?.[0] ?? seat;
        deck = (m.connectResp?.deckMessage?.deckCards ?? []).filter((x: unknown) => typeof x === 'number');
        continue;
      }
      const gs = m.gameStateMessage;
      if (gs) {
        const info = gs.gameInfo;
        if (info?.matchID && typeof info.gameNumber === 'number') {
          const id = `${info.matchID}-${info.gameNumber}`;
          if (id !== gameId) {
            gameId = id;
            matchId = info.matchID;
            prompts = 0;
            zones = new Map();
            objects = new Map();
            clear();
          }
        }
        for (const z of gs.zones ?? []) zones.set(z.zoneId, { type: z.type, owner: z.ownerSeatId ?? null, ids: z.objectInstanceIds ?? [] });
        for (const o of gs.gameObjects ?? []) {
          if (typeof o.grpId !== 'number') continue;
          objects.set(o.instanceId, o.grpId);
          if ((o.superTypes ?? []).includes('SuperType_Basic')) {
            const c = (o.subtypes ?? []).map((t: string) => BASIC_COLOR[t]).find(Boolean);
            if (c) basics[String(o.grpId)] = c;
          }
        }
        const ti = gs.turnInfo;
        if (ti && typeof ti.activePlayer === 'number') active = ti.activePlayer;
        // The game has started (turn 1) or ended: the decision is made.
        if ((ti && typeof ti.turnNumber === 'number' && ti.turnNumber >= 1) || info?.stage === 'GameStage_GameOver') clear();
      }
      if (m.type === 'GREMessageType_MulliganReq' && seat !== null && (m.systemSeatIds ?? []).includes(seat) && gameId) {
        prompts++;
        const handZone = [...zones.values()].find((z) => z.type === 'ZoneType_Hand' && z.owner === seat);
        const hand = (handZone?.ids ?? []).map((i) => objects.get(i)).filter((x): x is number => typeof x === 'number' && x > 0);
        showing = true;
        onEvent({
          kind: 'prompt',
          data: { gameId, set: setFromEvent(matchId ? eventOfMatch.get(matchId) ?? null : null), hand, deck: [...deck], onPlay: active === seat, prompt: prompts, basics: { ...basics } },
        });
      }
    }
  };
}
