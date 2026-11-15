// COPIED from draft-trainer/src/coach/engine.ts by scripts/sync-coach.mjs. Do not edit here;
// change the trainer and rerun the sync.

// The coach engine: how much each card in the pack is worth to YOUR deck at
// THIS pick, in win-rate points, like a chess engine's evaluation.
//
// Expected value of taking a card =
//   sum over the deck shapes you might end up in (a pair, a pair + splash,
//   three or four colors; weighted by how likely each is)
//     of: chance the card makes that deck x its win rate in that deck
//         + chance it doesn't x the win rate of the filler card that would play instead
//         - what that shape costs (measured from 17Lands at equal card quality,
//           cheaper with more fixing)
//   + a small bonus when it fills something your deck is short of (interaction,
//     card draw, two-drops), sized from how real decks did with more of it.
//
// Card quality (17Lands win rate when in hand) is the solid part. Everything
// else is an estimate, kept modest, and each part is reported so the coach
// can explain itself.

import { tagRoles, INTERACTION, type Role } from './roles.ts';
import { BASICS, COLOR_PAIRS, rateSet, type CardRow } from '../core/stats.ts';
import type { SetStats } from '../core/types.ts';
import { castableIn } from './deck.ts';
import { packSize, pickInPack, totalPicks } from './packsize.ts';

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
const sortPair = (p: string) => [...p].sort().join('');
export const PAIRS = COLOR_PAIRS.map(sortPair);

export type CoachCard = {
  name: string;
  cost: string;
  mv: number;
  colors: string[];
  type: string;
  text: string;
  roles?: { role: Role; why: string }[];
};

export type CoachModel = {
  cards: CoachCard[];
  /** Card-pair synergy (build-synergy.ts), attached after building; used when TUNING.synergyWeight > 0. */
  synergy?: Map<number, Map<number, number>> | null;
  /** Win rate when in hand, all decks, shrunk toward the set average for thin samples. */
  gih: number[];
  /** Win rate in each pair's decks (sorted pair key), shrunk toward the card's overall rate. */
  gihPair: Record<string, number[]>;
  /** How common each pair is with real drafters (share of games). */
  pairShare: Record<string, number>;
  /** The win rate of the filler card that plays when a pick doesn't make the deck. */
  replacement: number;
  /** The average card's win rate. */
  setMean: number;
  roles: Role[][];
  fixes: string[][];
  /** Colors a card needs to be played: its colors, or for a land the colors it makes. */
  fit: string[][];
  /** `fit` as a bit mask (W=1, U=2, B=4, R=8, G=16). */
  fitMask: number[];
  /** Mana symbols of each color in the cost (W, U, B, R, G; hybrid counts half). */
  pips: number[][];
  /** Shape prices in card-quality points per spell, by fixer bucket. */
  shapeTax: Record<ShapeKind, number[]>;
  /** Win rates of the set's nonland, nonbasic cards, ascending. */
  spellGihSorted: number[];
  /** Per pair (PAIRS order), per card: worth splashing in that pair's decks (one color away only). */
  splashOk: boolean[][];
  /** Per pair, per card: expected win rate when drawn as a splash in that pair's decks (NaN if not one color away). */
  splashQ: number[][];
  /** Per pair, per card: how often strong players splash it when they can (shrunk; NaN if not one color away). */
  splashRate: number[][];
};

/** The per-set splash file written by scripts/build-splash.ts. */
export type SplashFile = {
  onColor: Record<string, [number, number]>;
  fallback?: number[];
  cards: Record<string, { all: number[]; pairs: Record<string, number[]> }>;
};

/**
 * Sealed only (Ken 2026-11-14: keep draft and sealed knowledge separate). Measured on 17Lands
 * FRA Sealed games alone (research/draft/sealed-fra-self-grade-2026-11-14.md, MTG AI folder).
 */
export const SEALED_TUNING = {
  /**
   * Bomb credit: GIH points added to an A- or better card when building and scoring sealed decks.
   * Set on all 30 sets with 17Lands Sealed data (2026-11-15, scripts/sealed-lab.ts, half the runs
   * held out per set): +5 made the deck score track wins better than no credit in 27 of 30 sets,
   * +10 in 22, +15 in 18, and the bigger credits dulled the build-gap signal (worse in 28/30 at +10).
   * (FRA alone first suggested +10: its bombs were unusually strong; across sets an extra bomb adds
   * nothing beyond its own card quality.)
   */
  bombCredit: 5,
};

export const DRAFT_TUNING = {
  /**
   * Bomb credit for the draft coach (2026-11-14, Ken approved testing): GIH points added to an A- or
   * better card (draft grades). Draft decks with quality held fixed: a bomb is worth +1.1 pts beyond
   * its own quality, 34/34 sets (scripts/sealed-laws.ts PremierDraft). Held out: build advice +2 made
   * the deck score track wins better in 33/34 sets (scripts/coach-knobs.ts); picks: +3 changed 0.5% of
   * picks, 62%+ drafters took the credited pick 41% vs 25%, agreement up in 6/10 sets, down in 0, wins
   * flat (coach-color-lab.ts BOMB_CREDIT). +2: the smaller size both tests support.
   */
  bombCredit: 2,
};

/** The sealed coach: bombs count SEALED_TUNING.bombCredit more, in their main colors and as a splash. */
export function withBombCredit(model: CoachModel, bomb: boolean[], credit = SEALED_TUNING.bombCredit): CoachModel {
  if (!credit) return model;
  return {
    ...model,
    gih: model.gih.map((g, i) => g + (bomb[i] ? credit : 0)),
    splashQ: model.splashQ.map((row) => row.map((q, i) => q + (bomb[i] ? credit : 0))),
  };
}

export const TUNING = {
  /** Value per point of synergy with cards already in your pool (0 = off; tested in validate-coach). */
  synergyWeight: 0,
  /** Games at which a card's own sample counts as much as the prior. */
  shrinkGames: 400,
  /** Filler level (a low bar: tuned 2026-11-11, distinguishing awful cards from weak ones tracks winning best). */
  replacementPct: 0.05,
  /** Chance a card outside a deck shape's colors makes that deck anyway. */
  offColor: 0.04,
  /**
   * What is worth splashing, from 17Lands data per color pair (<SET>-splash.json,
   * scripts/build-splash.ts; Ken 2026-11-13: "certain synergies want to splash certain
   * cards", data driven). A card is a splash candidate for a pair when, splashed in that
   * pair's decks, drawing it beat drawing the pair's own cards by at least splashWorth
   * win-rate points, AND strong players splashed it at least splashRate of the time they
   * could. Thin samples shrink: pair -> the card in all pairs -> a fallback model.
   */
  splashWorth: 0,
  splashRate: 0.25,
  /** Shrinkage for the splash data: games drawn, and builds where it was available. */
  splashGames: 150,
  splashBuilds: 20,
  /**
   * The fallback when a set has no splash file (new sets): win-rate points vs the pair's
   * own cards = a + b x (GIH - own) + cheap non-removal + removal + 2+ symbols. Fitted on
   * FRA by build-splash.ts (107 well-sampled cards), and the pair's own cards are taken
   * as the set average + ownAboveMean.
   */
  splashFallback: [-1.727, 0.803, -0.472, 0.827, 0.642],
  ownAboveMean: 0.9,
  /**
   * In a splash or 3-4 color deck, a card outside its main pair (a splash card, a
   * third-color card) plays this often when castable, and pulls you that much less
   * toward that deck. 1 = always. Audit 2026-11-13: at 1 the coach took a stronger
   * one-color off-color card over an on-color one too often (it predicted such
   * cards make the deck 41% of the time; real 25%), and 62%+ drafters sided with
   * the old pair-only coach in those spots (33% vs 23%). At 0.6, on 6,539 held-out
   * FRA drafts: those spots even out (32% vs 31%), strong drafters side with this
   * coach over the old one 35% vs 27% overall, win correlation 0.045 (old 0.043).
   */
  thirdPlay: 0.6,
  /**
   * A shape's price is per spell, and a deck has ~23 spells: a pick that pulls you toward a
   * splash or a third color moves the whole deck's quality, not just its own card's. This many
   * spells' worth of the price is charged when scoring a pick (1 = the price of one card).
   * Tested 2026-11-13: 6 changed nothing, 23 overcorrected back into the old in-color
   * bias (strong drafters sided with the old coach 37% vs 26%). Left at 1.
   */
  shapeCostSpells: 1,
  /**
   * Making the 23: a castable card only plays if fewer than ~23 better spells in
   * that deck's colors end up in the pool. Expected better spells = those you
   * have + picks left x deckRate x share of the set that beats it. 0 = off.
   * Tested 2026-11-13 (coach-color-lab.ts, 6,539 held-out FRA drafts): 0.6 made
   * play chances far more honest (Brier 0.262 -> 0.202) but the grades tracked
   * winning worse (0.044 -> 0.031): it discounts solid on-color playables, and
   * taking those wins. Off, because the coach's job is advice that wins.
   */
  deckRate: 0,
  /** How soft the 23-card cut is (spells). */
  cutSoftness: 2.5,
  /**
   * How much less likely each deck shape is than a plain pair at the same card
   * strength (log-odds), per pack (rows) and fixers in the pool (0-1, 2-3, 4+).
   * Fitted to the final decks of 6,540 real FRA drafters (scripts/coach-color-lab.ts,
   * 2026-11-13; predicted shape shares then match real ones in every pack), with
   * more fixers never making a shape less likely.
   */
  shapePenalty: {
    splash: [[-1.8, -1.6, -1.6], [-2.3, -1.9, -1.9], [-2.6, -1.6, -1.6]],
    three: [[-2.4, -2.4, -2.4], [-4.5, -4.1, -3.8], [-5.1, -3.7, -2.6]],
    four: [[-3.8, -3.8, -2.6], [-7.4, -6.9, -6.1], [-7.8, -6.5, -4.4]],
  } as Record<Exclude<ShapeKind, 'pair'>, number[][]>,
  /**
   * What each shape costs in card-quality points per spell, by fixers in the deck
   * (0-1, 2-3, 4+), at equal card quality: 17Lands FRA games, 57,999 builds,
   * 2026-11-13 (scripts/validate-build.ts). More fixing never costs more. Used
   * when a set has no measured prices of its own (<SET>-builds.json shapeTax).
   */
  shapeTax: { pair: [0, 0, 0], splash: [1.17, 0.95, 0.95], three: [1.55, 1.31, 1.02], four: [1.96, 1.96, 1.96] } as Record<ShapeKind, number[]>,
  /** How fast you commit to colors as the pool grows. */
  commitRate: 0.22,
  /** Need bonuses: points per missing card, capped. */
  needInteraction: 0.35,
  needCardDraw: 0.25,
  needTwoDrop: 0.2,
  needCap: 1.2,
  /** Score each card as if taken: it pulls you toward its colors (1 = on). */
  lookahead: 1,
  /**
   * How much what is flowing counts toward a pair (log-odds per flow point).
   * Tested 2026-11-12 (scripts/coach-color-lab.ts, Ben Stark's "Drafting the Hard Way"): making
   * flow count for more with more picks left, or loosening commitment early, did not predict
   * final colors or wins any better on real FRA drafts, so it stays a plain nudge.
   */
  flowNow: 0.25,
};

function pips(cost: string): Record<string, number> {
  const out: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const m of cost.split(' // ')[0].matchAll(/\{([^}]+)\}/g)) {
    const parts = m[1].split('/').filter((p) => (COLORS as readonly string[]).includes(p));
    for (const p of parts) out[p] += 1 / parts.length;
  }
  return out;
}

function landColors(card: CoachCard): string[] {
  if (/any color|the chosen color/i.test(card.text)) return [...COLORS];
  const out = new Set<string>();
  for (const line of card.text.split('\n')) {
    if (!/\badd\b/i.test(line)) continue;
    for (const m of line.matchAll(/\{([WUBRG])\}/g)) out.add(m[1]);
  }
  return [...out];
}

/**
 * estimates: for an early set, a strength guess for cards whose win rate is
 * hidden; weighted like a sample the size of the prior, so it moves a card
 * halfway from average toward the guess.
 */
export function buildCoachModel(
  cards: CoachCard[],
  stats: SetStats,
  estimates: Record<string, { gih: number }> = {},
  /** The set's measured shape prices (<SET>-builds.json); the FRA defaults otherwise. */
  shapeTax?: Partial<Record<ShapeKind, number[]>> | null,
  /** The set's splash data (<SET>-splash.json); the fallback model otherwise. */
  splash?: SplashFile | null,
): CoachModel {
  const all = rateSet(stats, { deck: 'ALL', players: 'all', basis: 'gih', minGames: 0 });
  const graded = [...all.values()].filter((r) => r.values.gih !== null && (r.values.games ?? 0) >= 500 && !BASICS.has(r.name));
  const mean = graded.reduce((s, r) => s + r.values.gih!, 0) / graded.length;
  const shrink = (r: CardRow | undefined, prior: number) => {
    if (!r || r.values.gih === null) {
      const est = r ? estimates[r.name]?.gih : undefined;
      return est === undefined ? prior : (est + prior) / 2;
    }
    const g = r.values.games ?? 0;
    return (g * r.values.gih + TUNING.shrinkGames * prior) / (g + TUNING.shrinkGames);
  };
  const gih = cards.map((c) => (BASICS.has(c.name) ? mean - 10 : shrink(all.get(c.name), mean)));

  const gihPair: Record<string, number[]> = {};
  const pairGames: Record<string, number> = {};
  for (const pair of COLOR_PAIRS) {
    const key = sortPair(pair);
    const pr = rateSet(stats, { deck: pair, players: 'all', basis: 'gih', minGames: 0 });
    gihPair[key] = cards.map((c, i) => shrink(pr.get(c.name), gih[i]));
    pairGames[key] = stats.groups[`${pair}|all`]?.games ?? 0;
  }
  const totalGames = Object.values(pairGames).reduce((a, b) => a + b, 0) || 1;
  const pairShare = Object.fromEntries(PAIRS.map((p) => [p, pairGames[p] / totalGames]));

  const sorted = [...gih].sort((a, b) => a - b);
  const replacement = sorted[Math.floor(sorted.length * TUNING.replacementPct)];
  const roles = cards.map((c) => (c.roles ?? tagRoles(c)).map((r) => r.role));
  const fixes = cards.map((c, i) => (roles[i].includes('fixing') || /Land/.test(c.type) ? landColors(c) : []));
  // A dual land is "colorless" but only belongs in decks of its colors. Lands
  // that make any color (or only colorless mana) fit everywhere.
  const fit = cards.map((c, i) => {
    if (!/Land/.test(c.type) || c.colors.length > 0) return c.colors;
    const made = fixes[i].length ? fixes[i] : landColors(c);
    return made.length === 0 || made.length === 5 ? [] : made;
  });
  const fitMask = fit.map((f) => f.reduce((m, c) => m | (1 << COLORS.indexOf(c as (typeof COLORS)[number])), 0));
  const pipList = cards.map((c) => {
    const pp = pips(c.cost ?? '');
    return COLORS.map((k) => pp[k]);
  });
  const tax = { ...TUNING.shapeTax, ...(shapeTax ?? {}) } as Record<ShapeKind, number[]>;
  const spellGihSorted = cards.map((c, i) => (/Land/.test(c.type) || BASICS.has(c.name) ? null : gih[i])).filter((g): g is number => g !== null).sort((a, b) => a - b);
  const sp = splashTables(cards, gih, roles, mean, fitMask, pipList, splash ?? null);
  return { cards, gih, gihPair, pairShare, replacement, setMean: mean, roles, fixes, fit, fitMask, pips: pipList, shapeTax: tax, spellGihSorted, ...sp };
}

/**
 * Splash tables per pair and card, from the set's splash data with shrinkage
 * (pair -> card overall -> fallback model), or from the fallback model alone.
 */
function splashTables(
  cards: CoachCard[],
  gih: number[],
  roles: Role[][],
  setMean: number,
  fitMask: number[],
  pips: number[][],
  file: SplashFile | null,
): { splashOk: boolean[][]; splashQ: number[][]; splashRate: number[][] } {
  const ownAll = file ? Object.values(file.onColor).reduce((a, [g, w]) => [a[0] + g, a[1] + w], [0, 0]) : null;
  const ownAvg = ownAll && ownAll[0] > 0 ? (ownAll[1] / ownAll[0]) * 100 : setMean + TUNING.ownAboveMean;
  const fb = file?.fallback ?? TUNING.splashFallback;
  const K = TUNING.splashGames;
  const KR = TUNING.splashBuilds;
  const splashOk: boolean[][] = [];
  const splashQ: number[][] = [];
  const splashRate: number[][] = [];
  PAIRS.forEach((pair, pi) => {
    const pm = PAIR_MASKS[pi];
    const own = file?.onColor[pair] && file.onColor[pair][0] >= 200 ? (file.onColor[pair][1] / file.onColor[pair][0]) * 100 : ownAvg;
    const ok: boolean[] = [];
    const qs: number[] = [];
    const rs: number[] = [];
    cards.forEach((card, ix) => {
      const off = fitMask[ix] & ~pm;
      // One color away (and not a land): the only cards a splash is about.
      if (!off || off & (off - 1) || /Land/.test(card.type)) {
        ok.push(false); qs.push(NaN); rs.push(NaN);
        return;
      }
      const removal = roles[ix].some((r) => INTERACTION.includes(r));
      const cheap = card.mv <= 2 && !removal;
      const twoPips = Math.max(...pips[ix]) >= 2;
      const prior = own + fb[0] + fb[1] * (gih[ix] - own) + (cheap ? fb[2] : 0) + (removal ? fb[3] : 0) + (twoPips ? fb[4] : 0);
      const data = file?.cards[card.name];
      const a = data?.all;
      const p = data?.pairs[pair];
      const cardQ = a ? (a[5] * 100 + K * prior) / (a[4] + K) : prior;
      const q = p ? (p[5] * 100 + K * cardQ) / (p[4] + K) : cardQ;
      // Revealed preference: strong players' splash rate (all players' where strong ones are few).
      const rateOf = (c: number[]) => (c[2] >= 10 ? [c[3], c[2]] : [c[1], c[0]]);
      let rate = NaN;
      if (a) {
        const [sa, na] = rateOf(a);
        const cardRate = (sa + KR * 0.3) / (na + KR);
        if (p) {
          const [sp, np] = rateOf(p);
          rate = (sp + KR * cardRate) / (np + KR);
        } else rate = cardRate;
      }
      const worth = q - own;
      ok.push(worth >= TUNING.splashWorth && (Number.isNaN(rate) || rate >= TUNING.splashRate));
      qs.push(q);
      rs.push(rate);
    });
    splashOk.push(ok);
    splashQ.push(qs);
    splashRate.push(rs);
  });
  return { splashOk, splashQ, splashRate };
}

/** A card's value as a splash in a pair's decks (its expected win rate when drawn), or null if it is not worth splashing there. */
export function splashValue(model: CoachModel, ix: number, pair: string): number | null {
  const pi = PAIRS.indexOf(sortPair(pair));
  if (pi < 0 || !model.splashOk[pi][ix]) return null;
  return model.splashQ[pi][ix];
}

/** How often strong players splash a card in a pair's decks when they can (NaN without data). */
export function splashRateIn(model: CoachModel, ix: number, pair: string): number {
  const pi = PAIRS.indexOf(sortPair(pair));
  return pi < 0 ? NaN : model.splashRate[pi][ix];
}

export type PairOdds = { pair: string; p: number }[];

// ---------- Deck shapes (Ken 2026-11-12: splashes and 3+ color decks are real options) ----------
//
// The coach no longer assumes every deck is one two-color pair. It weighs the
// shapes real decks end up in: a pair, a pair plus a splash (at most 3 cards
// with one symbol of the splash color), three colors, and four-color soup.
// Shape definitions match the deck review (build.ts): 4+ spells = main color.

export type ShapeKind = 'pair' | 'splash' | 'three' | 'four';
export type DeckShape = {
  /** e.g. "UW", "UW+R", "RUW", "BRUW". */
  key: string;
  kind: ShapeKind;
  /** All colors the deck plays (sorted). */
  colors: string;
  /** The two main colors for a pair or a splash; empty for three/four colors. */
  core: string;
  /** The splash color, if any. */
  splash: string;
  mask: number;
  coreMask: number;
};
export type ShapeOdds = { shape: DeckShape; p: number }[];

const bit = (c: string) => 1 << COLORS.indexOf(c as (typeof COLORS)[number]);
const maskOf = (cs: Iterable<string>) => [...cs].reduce((m, c) => m | bit(c), 0);
const combos = (k: number): string[] => {
  const out: string[] = [];
  const go = (start: number, acc: string) => {
    if (acc.length === k) return void out.push(sortPair(acc));
    for (let i = start; i < COLORS.length; i += 1) go(i + 1, acc + COLORS[i]);
  };
  go(0, '');
  return out;
};
export const SHAPES: DeckShape[] = [
  ...PAIRS.map((p) => ({ key: p, kind: 'pair' as const, colors: p, core: p, splash: '', mask: maskOf(p), coreMask: maskOf(p) })),
  ...PAIRS.flatMap((p) =>
    COLORS.filter((x) => !p.includes(x)).map((x) => ({ key: `${p}+${x}`, kind: 'splash' as const, colors: sortPair(p + x), core: p, splash: x, mask: maskOf(p + x), coreMask: maskOf(p) })),
  ),
  ...combos(3).map((c) => ({ key: c, kind: 'three' as const, colors: c, core: '', splash: '', mask: maskOf(c), coreMask: maskOf(c) })),
  ...combos(4).map((c) => ({ key: c, kind: 'four' as const, colors: c, core: '', splash: '', mask: maskOf(c), coreMask: maskOf(c) })),
];
export const SHAPE_INDEX = new Map(SHAPES.map((s, i) => [s.key, i]));
const PAIR_MASKS = PAIRS.map((p) => maskOf(p));

/** Which pack a pool of this size is drafting (0-2). */
export const packOf = (poolSize: number) => Math.min(2, Math.floor(poolSize / packSize()));

/** Fixing buckets used by the shape prices: 0-1, 2-3, 4+ fixers. */
export const fixerBucket = (n: number) => (n <= 1 ? 0 : n <= 3 ? 1 : 2);

/** A fixer: a nonbasic card that makes mana of 2+ colors (or any color). */
export const isFixer = (model: CoachModel, ix: number) => model.fixes[ix].length >= 2 && !BASICS.has(model.cards[ix].name);

/**
 * Fixers that help a shape: for a splash, the ones that make the splash color;
 * for three or four colors, the ones that make at least two of its colors.
 */
export function shapeFixers(model: CoachModel, cards: number[], shape: DeckShape): number {
  if (shape.kind === 'pair') return 0;
  let n = 0;
  for (const ix of cards) {
    if (!isFixer(model, ix)) continue;
    const made = maskOf(model.fixes[ix]);
    if (shape.kind === 'splash' ? (made & bit(shape.splash)) !== 0 : popcount(made & shape.mask) >= 2) n += 1;
  }
  return n;
}
const popcount = (m: number) => { let n = 0; for (let x = m; x; x &= x - 1) n += 1; return n; };

/** Price of a shape in card-quality points per spell, given its fixers (measured per set; see validate-build.ts). */
export function shapeTax(model: CoachModel, shape: DeckShape, fixers: number): number {
  return model.shapeTax[shape.kind][fixerBucket(fixers)];
}

/**
 * How a card plays in a shape: 1 = in the deck's colors, 2 = as a splash card
 * (needs the splash color, and the splash data says it is worth it in that pair), 0 = not.
 */
export function roleIn(model: CoachModel, ix: number, shape: DeckShape): 0 | 1 | 2 {
  const f = model.fitMask[ix];
  if ((f & ~shape.mask) !== 0) return 0;
  if (shape.kind !== 'splash' || (f & ~shape.coreMask) === 0) return 1;
  if (/Land/.test(model.cards[ix].type)) return 1;
  // Worth splashing in THIS pair's decks, per the data (or the fallback model).
  return model.splashOk[PAIRS.indexOf(shape.core)][ix] ? 2 : 0;
}

/** How strongly one card pulls you toward the colors it is in (log-odds). */
function weight(model: CoachModel, ix: number): number {
  return TUNING.commitRate * Math.max(0.3, (model.gih[ix] - model.replacement) / 2 + 1);
}

/** A card's win rate in a shape: in its main pair's decks, or the best pair of the shape it fits. */
function qualityIn(model: CoachModel, ix: number, shape: DeckShape): number {
  // A splash card is worth what it did when splashed in this pair's decks.
  if (shape.kind === 'splash' && (model.fitMask[ix] & ~shape.coreMask) !== 0) {
    const q = model.splashQ[PAIRS.indexOf(shape.core)][ix];
    if (!Number.isNaN(q)) return q;
  }
  if (shape.core) return model.gihPair[shape.core][ix];
  let best = -Infinity;
  PAIRS.forEach((p, i) => {
    if ((PAIR_MASKS[i] & ~shape.mask) === 0 && (model.fitMask[ix] & ~PAIR_MASKS[i]) === 0) best = Math.max(best, model.gihPair[p][ix]);
  });
  return best === -Infinity ? model.gih[ix] : best;
}

const SPLASH_MAX = 3;
const DECK_SPELLS = 23;

/** Share of the set's spells with a higher win rate than `g` (for how many better cards are still to come). */
function shareBetter(model: CoachModel, g: number): number {
  const xs = model.spellGihSorted;
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] <= g) lo = mid + 1; else hi = mid; }
  return (xs.length - lo) / Math.max(1, xs.length);
}

/**
 * Chance a castable spell makes a deck's ~23 spells: fewer than 23 better
 * spells in those colors by the end (the ones you have + the ones still likely to come).
 */
function makesCut(model: CoachModel, g: number, better: number[], picksLeft: number): number {
  if (!TUNING.deckRate) return 1;
  let have = 0;
  while (have < better.length && better[have] > g) have += 1;
  const expected = have + Math.max(0, picksLeft) * TUNING.deckRate * shareBetter(model, g);
  return 1 / (1 + Math.exp((expected - (DECK_SPELLS - 0.5)) / TUNING.cutSoftness));
}

export type ShapeState = {
  strength: number[];
  /** Each shape's main pair as a color mask: its own colors for a pair, the core for a splash, the strongest pair inside a 3-4 color deck. */
  mainMask: number[];
  /** Win rates of the pool's spells that play in each shape (main colors), best first. */
  spellGih: number[][];
  /** The win rate a new splash card must beat to make the cut (3 splash cards max). */
  splashCut: number[];
  tax: number[];
};

/** Every shape's log-odds strength from your pool so far, plus what each one costs. */
export function shapeState(model: CoachModel, pool: number[], flow?: Record<string, number>): ShapeState {
  const strength: number[] = [];
  const mainMask: number[] = [];
  const splashCut: number[] = [];
  const tax: number[] = [];
  const spellGih: number[][] = [];
  const pairPrior = Object.fromEntries(PAIRS.map((p) => [p, Math.log(model.pairShare[p] * PAIRS.length + 0.2)]));
  for (const shape of SHAPES) {
    const main: number[] = [];
    const splashW: number[] = [];
    const splashG: number[] = [];
    const spells: number[] = [];
    for (const ix of pool) {
      const r = roleIn(model, ix, shape);
      if (r === 1) {
        main.push(weight(model, ix));
        if (!/Land/.test(model.cards[ix].type)) spells.push(model.gih[ix]);
      } else if (r === 2) { splashW.push(weight(model, ix)); splashG.push(model.gih[ix]); }
    }
    splashW.sort((a, b) => b - a);
    splashG.sort((a, b) => b - a);
    spellGih.push(spells.sort((a, b) => b - a));
    // A deck plays about 23 spells: past that, more cards in a shape add nothing.
    const counted = [...main, ...splashW.slice(0, SPLASH_MAX)].sort((a, b) => b - a).slice(0, DECK_SPELLS);
    let s = counted.reduce((a, b) => a + b, 0);
    s += shape.core ? pairPrior[shape.core] : Math.max(...PAIRS.filter((p, i) => (PAIR_MASKS[i] & ~shape.mask) === 0).map((p) => pairPrior[p]));
    if (flow) {
      const colors = shape.core || shape.colors;
      const sum = [...colors].reduce((a, c) => a + (flow[c] ?? 0), 0);
      s += TUNING.flowNow * sum * (2 / colors.length);
    }
    const fixers = shapeFixers(model, pool, shape);
    if (shape.kind !== 'pair') s += TUNING.shapePenalty[shape.kind][packOf(pool.length)][fixerBucket(fixers)];
    strength.push(s);
    // Pairs come first in SHAPES, so their strengths are known by the time a 3-4 color shape asks.
    let mainPair = shape.coreMask;
    if (shape.kind === 'three' || shape.kind === 'four') {
      let best = -Infinity;
      PAIR_MASKS.forEach((m, j) => {
        if ((m & ~shape.mask) === 0 && strength[j] > best) { best = strength[j]; mainPair = m; }
      });
    }
    mainMask.push(mainPair);
    splashCut.push(splashG.length >= SPLASH_MAX ? splashG[SPLASH_MAX - 1] : -Infinity);
    tax.push(shapeTax(model, shape, fixers));
  }
  return { strength, mainMask, spellGih, splashCut, tax };
}

function softmaxShapes(strength: number[]): number[] {
  const max = Math.max(...strength);
  const e = strength.map((s) => Math.exp(s - max));
  const total = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / total);
}

/** Pair odds from shape odds: a splash counts for its main pair; three or four colors split over their pairs. */
function marginalPairs(p: number[]): PairOdds {
  const out: Record<string, number> = Object.fromEntries(PAIRS.map((x) => [x, 0]));
  SHAPES.forEach((shape, i) => {
    if (shape.core) out[shape.core] += p[i];
    else {
      const inside = PAIRS.filter((_, j) => (PAIR_MASKS[j] & ~shape.mask) === 0);
      for (const q of inside) out[q] += p[i] / inside.length;
    }
  });
  return PAIRS.map((pair) => ({ pair, p: out[pair] })).sort((a, b) => b.p - a.p);
}

const shapeOdds = (p: number[]): ShapeOdds => SHAPES.map((shape, i) => ({ shape, p: p[i] })).sort((a, b) => b.p - a.p);

/** How likely you are to end in each pair, from your pool so far (and what's flowing). */
export function pairOdds(model: CoachModel, pool: number[], flow?: Record<string, number>): PairOdds {
  return marginalPairs(softmaxShapes(shapeState(model, pool, flow).strength));
}

/** How likely you are to end in each deck shape (pair, splash, three, four colors). */
export function deckShapeOdds(model: CoachModel, pool: number[], flow?: Record<string, number>): ShapeOdds {
  return shapeOdds(softmaxShapes(shapeState(model, pool, flow).strength));
}

export type CardEval = {
  index: number;
  /** Expected win-rate points this pick adds (the engine's evaluation). */
  ev: number;
  /** Chance the card ends up in your deck, across likely deck shapes. */
  playChance: number;
  /** The card's win rate in the most likely pair. */
  quality: number;
  need: number;
  needReason: string | null;
  /** Most of its play chance is as a splash card. */
  splash: boolean;
  /** Most of its play chance is in a three- or four-color deck. */
  third: boolean;
};

/** Counts of what the pool already has in your likely colors. */
function poolNeeds(model: CoachModel, pool: number[], colors: string) {
  let interaction = 0, draw = 0, twoDrops = 0;
  for (const ix of pool) {
    const c = model.cards[ix];
    if (!castableIn(c, [...colors])) continue;
    const roles = model.roles[ix];
    if (roles.some((r) => INTERACTION.includes(r))) interaction += 1;
    if (roles.includes('card draw')) draw += 1;
    if (c.mv === 2 && !/Land/.test(c.type)) twoDrops += 1;
  }
  return { interaction, draw, twoDrops };
}

export function evaluatePack(
  model: CoachModel,
  pack: number[],
  pool: number[],
  overallPick: number,
  flow?: Record<string, number>,
): { evals: CardEval[]; odds: PairOdds; shapes: ShapeOdds } {
  const state = shapeState(model, pool, flow);
  const p0 = softmaxShapes(state.strength);
  const odds = marginalPairs(p0);
  const shapes = shapeOdds(p0);
  const mean = model.replacement;
  const picksLeft = totalPicks() - 1 - overallPick;
  const needs = poolNeeds(model, pool, shapes[0].shape.colors);
  // Expected final counts if the rest of the draft adds at a typical rate.
  const expectInteraction = needs.interaction + picksLeft * 0.12;
  const expectDraw = needs.draw + picksLeft * 0.08;
  const expectTwo = needs.twoDrops + picksLeft * 0.1;
  const newFixer = (ix: number) => isFixer(model, ix);

  const evals = pack.map((ix): CardEval => {
    const card = model.cards[ix];
    const basic = BASICS.has(card.name);
    const w = weight(model, ix);
    const roles = SHAPES.map((shape) => roleIn(model, ix, shape));
    // Outside a shape's main pair (splash or third color), a card plays less often than one in it.
    const isLand = /Land/.test(card.type);
    const share = SHAPES.map((_, i) => (isLand || (model.fitMask[ix] & ~state.mainMask[i]) === 0 ? 1 : TUNING.thirdPlay));
    // "If I take this": the card pulls you toward the shapes it plays in (and a
    // fixer makes the shapes it fixes cheaper), which raises its own chance of
    // making the deck: this is what lets a gold card or a dual land count.
    let p = p0;
    if (TUNING.lookahead) {
      const s = state.strength.map((v, i) => {
        const shape = SHAPES[i];
        let x = v + (roles[i] ? w * share[i] : 0);
        if (newFixer(ix) && shape.kind !== 'pair') {
          const before = shapeFixers(model, pool, shape);
          const after = shapeFixers(model, [...pool, ix], shape);
          const row = TUNING.shapePenalty[shape.kind][packOf(pool.length)];
          if (after > before) x += row[fixerBucket(after)] - row[fixerBucket(before)];
        }
        return x;
      });
      p = softmaxShapes(s);
    }
    let ev = 0;
    let play = 0;
    let playSplash = 0;
    let playThird = 0;
    SHAPES.forEach((shape, i) => {
      const pi = p[i];
      if (pi < 1e-6) return;
      const r = roles[i];
      const spell = !/Land/.test(card.type);
      const cut = spell ? makesCut(model, model.gih[ix], state.spellGih[i], picksLeft) : 1;
      const playable = r === 1 || (r === 2 && model.gih[ix] > state.splashCut[i]);
      const chance = playable ? Math.max(TUNING.offColor, cut * share[i]) : TUNING.offColor;
      const q = qualityIn(model, ix, shape);
      // A card worse than filler would not make the deck anyway. Basic lands are
      // free and unlimited: always below any real card. Every deck pays its shape's price.
      const value = basic ? mean - 3 : Math.max(q, mean);
      ev += pi * ((basic ? value : chance * value + (1 - chance) * mean) - state.tax[i] * TUNING.shapeCostSpells);
      const counts = chance * (q > mean ? 1 : 0);
      play += pi * counts;
      if (r === 2) playSplash += pi * counts;
      if (r === 1 && (shape.kind === 'three' || shape.kind === 'four')) playThird += pi * counts;
    });
    const roleTags = model.roles[ix];
    let need = 0;
    let needReason: string | null = null;
    if (roleTags.some((r) => INTERACTION.includes(r)) && expectInteraction < 9) {
      need = Math.min(TUNING.needCap, TUNING.needInteraction * (9 - expectInteraction));
      needReason = `your deck is short on interaction (${needs.interaction} so far, aiming for about 9)`;
    // No "short on card draw" bonus (Ken 2026-11-13): across 34 sets, decks with more card
    // draw won LESS in 27 (research/draft/draft-science-2026-11-13.md); removing it left the
    // coach's validated accuracy unchanged. TUNING.needCardDraw is kept for experiments.
    } else if (card.mv === 2 && !/Land/.test(card.type) && expectTwo < 6) {
      need = Math.min(TUNING.needCap, TUNING.needTwoDrop * (6 - expectTwo));
      needReason = `your curve needs two-drops (${needs.twoDrops} so far)`;
    }
    need *= play;
    // Synergy with what you already have (only counts if the card makes your deck).
    let syn = 0;
    if (TUNING.synergyWeight > 0 && model.synergy) {
      const m = model.synergy.get(ix);
      if (m) for (const x of pool) syn += m.get(x) ?? 0;
      syn *= TUNING.synergyWeight * play;
    }
    const inTopPair = castableIn(card, [...odds[0].pair]);
    return {
      index: ix,
      ev: ev + need + syn,
      playChance: play,
      quality: model.gihPair[odds[0].pair][ix],
      need,
      needReason,
      splash: !inTopPair && play >= 0.1 && playSplash >= 0.5 * play,
      third: !inTopPair && play >= 0.1 && playThird >= 0.5 * play,
    };
  });
  return { evals: evals.sort((a, b) => b.ev - a.ev), odds, shapes };
}

// ---------- Grading a pick, chess.com style ----------

export type Badge = 'Best' | 'Excellent' | 'Good' | 'Inaccuracy' | 'Mistake' | 'Blunder';

/** Win-rate points given up -> badge. Near-ties count as Best: no fake precision. */
export const BADGE_STEPS: [number, Badge][] = [
  [0.5, 'Best'],
  [1.25, 'Excellent'],
  [2.5, 'Good'],
  [4.5, 'Inaccuracy'],
  [7.0, 'Mistake'],
  [Infinity, 'Blunder'],
];

/**
 * Late picks (10-14 of a pack) choose between cards that rarely make the
 * deck, so a miss there counts half. A "Blunder" at pick 13 teaches nothing.
 */
export const lateWeight = (overallPick: number) => (pickInPack(overallPick) >= packSize() - 5 ? 0.5 : 1);
export const badgeFor = (loss: number): Badge => BADGE_STEPS.find(([max]) => loss <= max)![1];

/** Per-pick accuracy, 0-100: 100 at no loss, about 50 at a 4-point loss. */
export const accuracyFor = (loss: number) => 100 * Math.exp(-loss / 5.8);

export function gradePick(model: CoachModel, pack: number[], pool: number[], overallPick: number, taken: number, flow?: Record<string, number>) {
  const { evals, odds } = evaluatePack(model, pack, pool, overallPick, flow);
  const best = evals[0];
  const mine = evals.find((e) => e.index === taken) ?? evals[evals.length - 1];
  const loss = Math.max(0, best.ev - mine.ev) * lateWeight(overallPick);
  return { loss, badge: badgeFor(loss), accuracy: accuracyFor(loss), best, mine, evals, odds };
}
