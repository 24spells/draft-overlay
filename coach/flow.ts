// COPIED from draft-trainer/src/lib/flow.ts by scripts/sync-coach.mjs. Do not edit here;
// change the trainer and rerun the sync.

// Flow: which colors are reaching you more (or less) than usual.
//
// For each pack you look at, measure the good material of each color in it
// ("mass": every above-average card counts by how much better than average it
// is; gold cards split across their colors). Compare with what a seat usually
// sees at that pick (the baseline, from simulated drafts). Surplus means the
// seats feeding you are not taking that color.
//
// Direction matters: packs 1 and 3 come from your right, pack 2 from your
// left. Pack 1's read carries into pack 3 (same neighbors).

import type { DraftCard } from './bot.ts';
import type { DraftState } from '../core/types.ts';

export const FLOW_COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export type FlowColor = (typeof FLOW_COLORS)[number];

export type FlowBaseline = {
  set: string;
  drafts: number;
  picks: Record<FlowColor, { mean: number; sd: number }>[];
};

/** Good material per color in one pack. */
export function packMass(pack: number[], cards: DraftCard[]): Record<FlowColor, number> {
  const out: Record<FlowColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const ix of pack) {
    const card = cards[ix];
    if (card.value <= 0 || card.colors.length === 0) continue;
    for (const c of card.colors) out[c as FlowColor] += card.value / card.colors.length;
  }
  return out;
}

/**
 * The read's settings, in one place so they can be tuned against the answer key
 * (scripts/tune-flow.ts: what the bots really took). Defaults as first built.
 */
export const FLOW_TUNING = {
  /** Floor on a pick's spread, so one decent card in a thin pack cannot swing the read. */
  sdFloor: 0.15,
  /** Cap per pick, same reason. */
  zCap: 2.5,
  /** Picks before this (0-based) show nearly full packs: too little signal to count. */
  firstPick: 2,
  /** Picks after this are leftovers: they count lateWeight. */
  latePick: 8,
  lateWeight: 0.5,
  /** Pack 1's read, once pack 3 has started, counts this much (same neighbors, older news). */
  pack1Later: 0.6,
  /** Score at which a color counts as flowing (or, negative, dry). */
  flowingAt: 1,
};
const weightFor = (pick: number) => (pick < FLOW_TUNING.firstPick ? 0 : pick <= FLOW_TUNING.latePick ? 1 : FLOW_TUNING.lateWeight);

export type FlowRead = {
  /** Which neighbor feeds you this pack. */
  from: 'right' | 'left';
  /** Per color: standardized surplus (+ flowing, - dried up), and its picks of evidence. */
  colors: { color: FlowColor; score: number; level: 'flowing' | 'normal' | 'dry' }[];
  /** Picks that contributed. */
  evidence: number;
};

export async function loadFlowBaseline(code: string): Promise<FlowBaseline | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}sets/${code}-flow.json`);
    return response.ok ? ((await response.json()) as FlowBaseline) : null;
  } catch {
    return null;
  }
}

/**
 * The flow read for one direction, from the packs you have seen. `upTo`
 * limits it to picks before a given overall pick (for a live read that
 * includes the pack in front of you, pass the current pack separately).
 */
export function readFlow(
  draft: DraftState,
  cards: DraftCard[],
  baseline: FlowBaseline,
  from: 'right' | 'left',
  current?: { pack: number[]; round: number; pick: number },
): FlowRead {
  const rounds = from === 'right' ? [0, 2] : [1];
  const seen = draft.log
    .filter((rec) => rounds.includes(rec.round))
    .map((rec) => ({ pack: rec.shown, round: rec.round, pick: rec.pick }));
  if (current && rounds.includes(current.round)) seen.push(current);

  const sum: Record<FlowColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let weightTotal = 0;
  let evidence = 0;
  for (const s of seen) {
    const w = weightFor(s.pick) * (s.round === 0 && from === 'right' && seen.some((x) => x.round === 2) ? FLOW_TUNING.pack1Later : 1);
    if (w === 0) continue;
    const mass = packMass(s.pack, cards);
    const base = baseline.picks[s.pick];
    for (const c of FLOW_COLORS) {
      // A floor on the spread and a cap per pick, so one decent card in a
      // late, near-empty pack cannot swing the read on its own.
      const z = (mass[c] - base[c].mean) / Math.max(base[c].sd, FLOW_TUNING.sdFloor);
      sum[c] += w * Math.max(-FLOW_TUNING.zCap, Math.min(FLOW_TUNING.zCap, z));
    }
    weightTotal += w;
    evidence += 1;
  }
  // Average surplus per pick, scaled up with evidence (more picks, more sure).
  const scale = weightTotal > 0 ? Math.sqrt(weightTotal) / weightTotal : 0;
  return {
    from,
    evidence,
    colors: FLOW_COLORS.map((color) => {
      const score = sum[color] * scale;
      return { color, score, level: score >= FLOW_TUNING.flowingAt ? 'flowing' : score <= -FLOW_TUNING.flowingAt ? 'dry' : 'normal' };
    }),
  };
}

/** Which neighbor feeds you in a given round (0-based). */
export const feederOf = (round: number): 'right' | 'left' => (round === 1 ? 'left' : 'right');

/**
 * Ground truth the simulator knows: the colors of the seats feeding you. For
 * packs from your right, the seat on your right matters most, then the next.
 */
export function feederColors(draft: DraftState, from: 'right' | 'left', topColors: (pool: number[]) => string[]): string[][] {
  const seats = from === 'right' ? [7, 6] : [1, 2];
  return seats.map((s) => topColors(draft.pools[s]));
}

/**
 * The wheel (2026-11-13): the pack you see 8 picks later is the pack you saw
 * before, minus your pick and exactly one card taken by each other seat. So the
 * missing good cards are hard evidence of what the table drafts. Per color: the
 * share of its good material (above-average cards, gold split) the table took.
 * A color whose good cards keep wheeling is underdrafted. Returns, per color,
 * how much LESS of it was taken than the table's average take (+ = open), or
 * null before any pack has wheeled.
 *
 * TESTED 2026-11-13, NOT USED (scripts/test-wheel.ts): against the answer key it found
 * the open color less often than the flow read (unseen sets 47.8% vs 57.0%; chance 40%),
 * and no blend helped. The wheel sees what the whole table took, not which neighbor took
 * it; "open to you" depends on your nearest feeders. Kept for future experiments.
 */
export function wheelRead(draft: DraftState, cards: DraftCard[], seats = 8): Record<FlowColor, number> | null {
  const byPick = new Map(draft.log.map((rec) => [`${rec.round}:${rec.pick}`, rec]));
  const taken: Record<FlowColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const avail: Record<FlowColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let wheels = 0;
  for (const rec of draft.log) {
    const later = byPick.get(`${rec.round}:${rec.pick + seats}`);
    if (!later) continue;
    wheels += 1;
    const left = [...later.shown];
    const gone: number[] = [];
    const mine = [...rec.shown];
    mine.splice(mine.indexOf(rec.taken), 1);
    for (const ix of mine) {
      const at = left.indexOf(ix);
      if (at >= 0) left.splice(at, 1);
      else gone.push(ix);
    }
    const add = (into: Record<FlowColor, number>, ixs: number[]) => {
      for (const ix of ixs) {
        const c = cards[ix];
        if (c.value <= 0 || !c.colors.length) continue;
        for (const col of c.colors) into[col as FlowColor] += c.value / c.colors.length;
      }
    };
    add(avail, mine);
    add(taken, gone);
  }
  if (!wheels) return null;
  const rate: Record<FlowColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let sumT = 0, sumA = 0;
  for (const c of FLOW_COLORS) { sumT += taken[c]; sumA += avail[c]; }
  const avg = sumA > 0 ? sumT / sumA : 0;
  for (const c of FLOW_COLORS) rate[c] = avail[c] > 0.5 ? avg - taken[c] / avail[c] : 0;
  return rate;
}
