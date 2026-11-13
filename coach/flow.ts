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

const SD_FLOOR = 0.15;
const Z_CAP = 2.5;

/** Picks 1-2 show nearly full packs: too little signal to count. */
const FIRST_SIGNAL_PICK = 2;
/** Very late packs are leftovers: count them less. */
const weightFor = (pick: number) => (pick < FIRST_SIGNAL_PICK ? 0 : pick <= 8 ? 1 : 0.5);

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
    const w = weightFor(s.pick) * (s.round === 0 && from === 'right' && seen.some((x) => x.round === 2) ? 0.6 : 1);
    if (w === 0) continue;
    const mass = packMass(s.pack, cards);
    const base = baseline.picks[s.pick];
    for (const c of FLOW_COLORS) {
      // A floor on the spread and a cap per pick, so one decent card in a
      // late, near-empty pack cannot swing the read on its own.
      const z = (mass[c] - base[c].mean) / Math.max(base[c].sd, SD_FLOOR);
      sum[c] += w * Math.max(-Z_CAP, Math.min(Z_CAP, z));
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
      return { color, score, level: score >= 1 ? 'flowing' : score <= -1 ? 'dry' : 'normal' };
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
