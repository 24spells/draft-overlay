// COPIED from draft-trainer/src/draft/bot.ts by scripts/sync-coach.mjs. Do not edit here;
// change the trainer and rerun the sync.

// Level-1 bots with personalities. Each bot rolls a personality before the
// draft (a favorite color, how fast it commits, whether it chases rares, how
// much it watches signals) so the table drafts like a mix of real people:
// some take the can't-miss card, some pass a bomb for their color, some pivot.
//
// Card strength blends how well a card wins (17Lands win rate when in hand)
// with how early real drafters take it; each personality weighs the two
// differently.

import { BASICS, COLOR_PAIRS, type CardRow } from '../core/stats.ts';
import type { SetStats } from '../core/types.ts';
import { gaussian, type Rng } from './rng.ts';

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/** What the engine and bots need to know about each card, by card index. */
export type DraftCard = {
  name: string;
  colors: string[];
  rarity: string;
  isLand: boolean;
  isBasic: boolean;
  /** Win rate when in hand, in standard deviations, shrunk for thin samples. */
  winZ: number;
  /** How early humans take it, in standard deviations (earlier = higher). */
  pickZ: number;
  /** A balanced blend of the two; used for color strength and reports. */
  value: number;
};

/** Everything bots need: card strengths and how popular each color pair is. */
export type BotContext = {
  cards: DraftCard[];
  /** Multiplier per color pair (sorted letters, e.g. "BU"), 1 = average popularity. */
  pairPrior: Record<string, number>;
};

export type Archetype =
  | 'steady'
  | 'cantmiss'
  | 'loyalist'
  | 'rares'
  | 'signals'
  | 'crowd'
  | 'loose';

export const ARCHETYPES: Record<Archetype, { name: string; blurb: string }> = {
  steady: { name: 'Steady', blurb: 'Takes good cards and settles into two colors at a normal pace.' },
  cantmiss: { name: "Can't-miss", blurb: 'Takes the highest win-rate card and barely commits to colors.' },
  loyalist: { name: 'Color loyalist', blurb: 'Married to a favorite color early. Passes strong off-color cards.' },
  rares: { name: 'Rare drafter', blurb: 'Overvalues rares and mythics.' },
  signals: { name: 'Signal reader', blurb: 'Stays open, watches what is flowing, and pivots into the open lane.' },
  crowd: { name: 'Pick-order follower', blurb: 'Drafts mostly by what the crowd takes early, like following a tier list.' },
  loose: { name: 'Loose', blurb: 'Unpredictable and often a little off.' },
};

export type BotProfile = {
  archetype: Archetype;
  favorite: string;
  /** Share of card strength from win rate; the rest is how early humans take it. */
  winWeight: number;
  /** Randomness in each pick (standard deviations). */
  noise: number;
  /** How hard it commits to its colors as the draft goes on. */
  commit: number;
  /** Bonus for its favorite color. */
  lean: number;
  /** Bonus for rares and mythics. */
  rareBonus: number;
  /** How much what is flowing (signals) steers its colors. */
  signalWeight: number;
  /** Penalty for gold cards before colors are set. */
  goldEarly: number;
};

/** Per-seat memory of what each color has been passing. */
export type Signals = Record<string, number>;

export const emptySignals = (): Signals => ({ W: 0, U: 0, B: 0, R: 0, G: 0 });

const sortPair = (pair: string) => [...pair].sort().join('');

/**
 * How often real players end up in each two-color pair, from 17Lands game
 * counts, softened so a popular pair nudges bots rather than dictating.
 * 0.12 matched the real FRA pair shares best in simulation (2026-11-11).
 */
export function buildPairPrior(stats: SetStats, softness = 0.12): Record<string, number> {
  const games = COLOR_PAIRS.map((p) => stats.groups[`${p}|all`]?.games ?? 0);
  const total = games.reduce((s, g) => s + g, 0);
  const average = total / COLOR_PAIRS.length;
  const out: Record<string, number> = {};
  COLOR_PAIRS.forEach((p, i) => {
    out[sortPair(p)] = total > 0 && games[i] > 0 ? (games[i] / average) ** softness : 1;
  });
  return out;
}

/**
 * Table-wide tuning, fitted so the whole table matches real FRA humans
 * (scripts/sim-bots.ts vs scripts/human-benchmark.ts, 2026-11-11):
 * pivot after pack 1 27% (humans 28%), on-color picks 70% (humans 71%),
 * first pick matches the human 51% (crowd consensus matches 62%).
 * Known gap: blue still a little overdrafted (BU 24% vs 17%).
 */
export const TUNING = {
  /** Scales every bot's color commitment. */
  commitScale: 0.55,
  /** Picks until commitment reaches full strength. */
  rampPicks: 28,
  /** Ceiling on commitment strength. */
  maxCommit: 1.6,
  /** How strongly what is flowing counts toward a color. */
  signalScale: 1.2,
  /** Scales every bot's pick-to-pick randomness. */
  noiseScale: 1,
};

/** Games in hand at which a card's win rate counts half. Shrinks thin samples. */
const SHRINK_GAMES = 300;

function meanSd(values: (number | null)[]): { mean: number; sd: number } {
  const present = values.filter((v): v is number => v !== null);
  const mean = present.reduce((s, v) => s + v, 0) / present.length;
  const sd = Math.sqrt(present.reduce((s, v) => s + (v - mean) ** 2, 0) / present.length) || 1;
  return { mean, sd };
}

export function buildDraftCards(
  cards: { name: string; colors: string[]; type: string; rarity: string }[],
  rows: Map<string, CardRow>,
): DraftCard[] {
  const rowFor = cards.map((c) => rows.get(c.name));
  // The reference pool: non-basic cards with a solid sample.
  const pool = rowFor.filter(
    (r, i): r is CardRow => !!r && !BASICS.has(cards[i].name) && (r.values.games ?? 0) >= 200,
  );
  const win = meanSd(pool.map((r) => r.values.gih));
  const pick = meanSd(pool.map((r) => r.values.ata));

  return cards.map((card, i) => {
    const isBasic = card.type.startsWith('Basic Land');
    const row = rowFor[i];
    let winZ = -1;
    let pickZ = -1;
    if (isBasic) {
      winZ = -4;
      pickZ = -4;
    } else if (row && row.values.gih !== null) {
      const games = row.values.games ?? 0;
      winZ = ((row.values.gih - win.mean) / win.sd) * (games / (games + SHRINK_GAMES));
      // Lower average pick = taken earlier = valued more, so flip the sign.
      pickZ = row.values.ata === null ? 0 : -(row.values.ata - pick.mean) / pick.sd;
    }
    return {
      name: card.name,
      colors: card.colors,
      rarity: card.rarity,
      isLand: card.type.includes('Land'),
      isBasic,
      winZ,
      pickZ,
      value: 0.7 * winZ + 0.3 * pickZ,
    };
  });
}

/** How often each personality shows up at the table, out of 100. */
const ARCHETYPE_WEIGHTS: [Archetype, number][] = [
  ['steady', 30],
  ['signals', 16],
  ['loyalist', 15],
  ['cantmiss', 12],
  ['rares', 12],
  ['crowd', 10],
  ['loose', 5],
];

const BASE: Record<Archetype, Omit<BotProfile, 'archetype' | 'favorite'>> = {
  steady: { winWeight: 0.7, noise: 0.3, commit: 1.0, lean: 0.15, rareBonus: 0.1, signalWeight: 1.0, goldEarly: -0.25 },
  cantmiss: { winWeight: 0.95, noise: 0.15, commit: 0.6, lean: 0.0, rareBonus: 0.0, signalWeight: 0.5, goldEarly: -0.1 },
  loyalist: { winWeight: 0.7, noise: 0.3, commit: 1.5, lean: 0.6, rareBonus: 0.1, signalWeight: 0.3, goldEarly: -0.3 },
  rares: { winWeight: 0.55, noise: 0.35, commit: 0.9, lean: 0.15, rareBonus: 0.55, signalWeight: 0.8, goldEarly: -0.15 },
  signals: { winWeight: 0.7, noise: 0.25, commit: 0.65, lean: 0.05, rareBonus: 0.1, signalWeight: 2.5, goldEarly: -0.3 },
  crowd: { winWeight: 0.3, noise: 0.25, commit: 1.0, lean: 0.1, rareBonus: 0.15, signalWeight: 1.0, goldEarly: -0.25 },
  loose: { winWeight: 0.6, noise: 0.7, commit: 0.9, lean: 0.25, rareBonus: 0.2, signalWeight: 0.6, goldEarly: -0.1 },
};

export function randomProfile(rng: Rng, archetype?: Archetype): BotProfile {
  let kind = archetype;
  if (!kind) {
    let roll = rng() * 100;
    kind = ARCHETYPE_WEIGHTS[ARCHETYPE_WEIGHTS.length - 1][0];
    for (const [k, w] of ARCHETYPE_WEIGHTS) {
      if (roll < w) {
        kind = k;
        break;
      }
      roll -= w;
    }
  }
  // Jitter every setting by up to about 15% so no two bots are identical.
  const jitter = (x: number) => x * (0.85 + rng() * 0.3);
  const base = BASE[kind];
  return {
    archetype: kind,
    favorite: COLORS[Math.floor(rng() * 5)],
    winWeight: Math.min(1, jitter(base.winWeight)),
    noise: jitter(base.noise),
    commit: jitter(base.commit),
    lean: jitter(base.lean),
    rareBonus: jitter(base.rareBonus),
    signalWeight: jitter(base.signalWeight),
    goldEarly: base.goldEarly,
  };
}

/**
 * Remember what a pack shows about which colors are open. A strong card still
 * in the pack several picks in means the seats upstream are not in its color.
 */
export function observePack(signals: Signals, pack: number[], pickInRound: number, cards: DraftCard[]): void {
  if (pickInRound < 2) return;
  const lateness = Math.min(1, (pickInRound - 1) / 6);
  for (const i of pack) {
    const card = cards[i];
    if (card.value <= 0.3 || card.colors.length === 0) continue;
    for (const c of card.colors) signals[c] += ((card.value - 0.3) * lateness) / card.colors.length;
  }
}

/** Pack 2 comes from the other side of the table, so old signals fade. */
export function fadeSignals(signals: Signals): void {
  for (const c of COLORS) signals[c] *= 0.6;
}

/** How much each color the pool already has, weighted by card strength. */
export function colorAffinity(pool: number[], cards: DraftCard[]): Record<string, number> {
  const out: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const i of pool) {
    const card = cards[i];
    if (card.colors.length === 0) continue;
    const weight = Math.max(0, card.value + 1.5) / card.colors.length;
    for (const c of card.colors) out[c] += weight;
  }
  return out;
}

/**
 * The pool's two colors: the pair with the most strength behind it, weighted
 * by how popular that pair is with real players when a prior is given.
 */
export function topColors(affinity: Record<string, number>, pairPrior?: Record<string, number>): string[] {
  const present = COLORS.filter((c) => affinity[c] > 0);
  if (present.length <= 1) return present;
  let best: string[] = [];
  let bestScore = -Infinity;
  for (let i = 0; i < COLORS.length; i += 1) {
    for (let j = i + 1; j < COLORS.length; j += 1) {
      const a = COLORS[i];
      const b = COLORS[j];
      const score = (affinity[a] + affinity[b]) * (pairPrior?.[sortPair(a + b)] ?? 1);
      if (score > bestScore) {
        bestScore = score;
        best = [a, b];
      }
    }
  }
  return best;
}

/** Score every card in the pack for one bot; the bot takes the highest. */
export function botChoice(
  pack: number[],
  pool: number[],
  overallPick: number,
  profile: BotProfile,
  signals: Signals,
  context: BotContext,
  rng: Rng,
): number {
  const { cards } = context;
  const affinity = colorAffinity(pool, cards);
  // What is flowing pulls the bot toward open colors; signal readers most.
  for (const c of COLORS) affinity[c] += TUNING.signalScale * profile.signalWeight * signals[c];
  affinity[profile.favorite] += profile.lean * 3;
  const top = topColors(affinity, context.pairPrior);
  // Commitment ramps up from 0 at the first pick.
  const weight =
    TUNING.commitScale * profile.commit * Math.min(TUNING.maxCommit, (overallPick / TUNING.rampPicks) * TUNING.maxCommit);

  let best = pack[0];
  let bestScore = -Infinity;
  for (const i of pack) {
    const card = cards[i];
    const strength = profile.winWeight * card.winZ + (1 - profile.winWeight) * card.pickZ;
    let fit = 0;
    if (card.colors.length === 0) {
      fit = card.isLand ? 0 : 0.3;
    } else if (top.length > 0) {
      const inTop = card.colors.filter((c) => top.includes(c)).length;
      fit = inTop === card.colors.length ? 1 : inTop > 0 ? -0.4 : -1;
    }
    const lean = card.colors.includes(profile.favorite) ? profile.lean / card.colors.length : 0;
    const rare = card.rarity === 'mythic' ? profile.rareBonus * 1.3 : card.rarity === 'rare' ? profile.rareBonus : 0;
    const gold = card.colors.length > 1 && overallPick < 5 ? profile.goldEarly : 0;
    const score = strength + weight * fit + lean + rare + gold + TUNING.noiseScale * profile.noise * gaussian(rng);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
