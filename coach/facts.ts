// COPIED from draft-trainer/src/core/facts.ts by scripts/sync-coach.mjs. Do not edit here;
// change the trainer and rerun the sync.

// The fact sheet for every card: what can be computed or read, no opinions.
// Card reports and the coach build their explanations from these facts, so
// every claim they make can be traced to a number or to the card's text.
// Set-agnostic: works on any set's file and 17Lands stats.

import type { Role } from './roles.ts';
import { BASICS, COLOR_PAIRS, rateSet, type CardRow } from '../core/stats.ts';
import type { SetStats } from '../core/types.ts';

export type FactCard = {
  name: string;
  type: string;
  text: string;
  mv: number;
  pt: string | null;
  rarity: string;
  colors: string[];
  roles?: { role: Role; why: string }[];
};

export type CardFacts = {
  name: string;
  /** Creature body vs. the set's typical common/uncommon creature at the same cost. */
  body: { p: number; t: number; mv: number; avgP: number; avgT: number; delta: number; verdict: 'above' | 'typical' | 'below' } | null;
  keywords: string[];
  roles: Role[];
  /** What the card wants around it, with the words that show it. */
  wants: { hook: string; why: string }[];
  /** Opening hand vs. drawn later, relative to the set's usual gap. */
  timing: { oh: number; gd: number; rel: number; mv: number; verdict: 'early' | 'late' | 'even' } | null;
  /** Points of win rate drawing it adds, vs. the set average. */
  lift: { iwd: number; setAvg: number } | null;
  /** Performance in each color pair, vs. other cards in that pair. Best first. */
  pairs: { pair: string; gih: number; rel: number; games: number }[];
  /** How early drafters take it vs. how well it wins. */
  demand: { ata: number; fairAta: number; gap: number; verdict: 'overdrafted' | 'underrated' | 'fair' } | null;
  games: number;
  lowSample: boolean;
};

const KEYWORDS = [
  'flying', 'menace', 'trample', 'deathtouch', 'lifelink', 'vigilance', 'haste', 'reach',
  'first strike', 'double strike', 'flash', 'ward', 'hexproof', 'indestructible', 'prowess', 'defender',
];

/** Synergy hooks: what a card rewards you for having or doing. */
const HOOKS: { hook: string; test: RegExp }[] = [
  { hook: 'creatures entering', test: /(?:another creature|a creature|creatures?) you control enters?/i },
  { hook: 'casting noncreature spells', test: /noncreature spell|instant or sorcery spell|whenever you cast an instant/i },
  // Cares about counters (rewards them), not just makes them.
  { hook: '+1/+1 counters', test: /with (?:a|one or more) \+1\/\+1 counters?|for each \+1\/\+1 counter|\+1\/\+1 counters? among/i },
  { hook: 'playing a land every turn', test: /landfall|whenever a land you control enters/i },
  { hook: 'a full graveyard', test: /threshold|cards? in your graveyard|seven or more cards/i },
  { hook: 'planeswalkers', test: /empower jace|planeswalkers? you control/i },
  { hook: 'artifacts', test: /artifacts? you control|sacrifice (?:another )?artifact|whenever you cast an artifact/i },
  { hook: 'gaining life', test: /whenever you gain life/i },
  { hook: 'legendary cards', test: /legendary (?:creature|spell|permanent|card)s?(?! you don't)/i },
  { hook: 'attacking', test: /whenever [^.]*attacks/i },
];

const strip = (text: string) => text.replace(/\([^)]*\)/g, '');

function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function sd(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2))) || 1;
}

function parsePt(pt: string | null): [number, number] | null {
  if (!pt) return null;
  const [p, t] = pt.split('/').map(Number);
  return Number.isFinite(p) && Number.isFinite(t) ? [p, t] : null;
}

const mvBucket = (mv: number) => Math.max(1, Math.min(6, Math.floor(mv)));

export function buildFacts(cards: FactCard[], rows: Map<string, CardRow>, stats: SetStats): Map<string, CardFacts> {
  const isGraded = (r: CardRow | undefined): r is CardRow => !!r && !r.lowSample && !BASICS.has(r.name);

  // Typical creature body at each mana value, from commons and uncommons (rares skew it).
  const bodies = new Map<number, [number, number][]>();
  for (const c of cards) {
    const pt = parsePt(c.pt);
    if (!pt || !/Creature/.test(c.type) || !['common', 'uncommon'].includes(c.rarity)) continue;
    const mv = mvBucket(c.mv);
    bodies.set(mv, [...(bodies.get(mv) ?? []), pt]);
  }

  const graded = [...rows.values()].filter(isGraded);
  // The usual gap between drawn-later and opening-hand win rates, per mana
  // value: expensive cards naturally do differently from the opening hand, so
  // each card is compared with cards of its own cost.
  const mvOf = new Map(cards.map((c) => [c.name, mvBucket(c.mv)]));
  const gapOf = (r: CardRow) => r.values.gd! - r.values.oh!;
  const withTiming = graded.filter((r) => r.values.gd !== null && r.values.oh !== null);
  const overallGap = mean(withTiming.map(gapOf));
  const timingGap = new Map<number, number>();
  for (let mv = 1; mv <= 6; mv += 1) {
    const at = withTiming.filter((r) => mvOf.get(r.name) === mv);
    timingGap.set(mv, at.length >= 10 ? mean(at.map(gapOf)) : overallGap);
  }
  const setIwd = mean(graded.filter((r) => r.values.iwd !== null).map((r) => r.values.iwd!));
  const pickPool = graded.filter((r) => r.values.ata !== null && r.values.gih !== null);
  const winMean = mean(pickPool.map((r) => r.values.gih!));
  const winSd = sd(pickPool.map((r) => r.values.gih!));
  const ataMean = mean(pickPool.map((r) => r.values.ata!));
  const ataSd = sd(pickPool.map((r) => r.values.ata!));

  // Each color pair's ratings, and that pair's average card.
  const pairRows = COLOR_PAIRS.map((pair) => {
    const pr = rateSet(stats, { deck: pair, players: 'all', basis: 'gih', minGames: 200 });
    const avg = mean([...pr.values()].filter(isGraded).map((r) => r.values.gih!).filter((v) => v !== null));
    return { pair, pr, avg };
  });

  const out = new Map<string, CardFacts>();
  for (const card of cards) {
    const row = rows.get(card.name);
    const text = strip(card.text);

    let body: CardFacts['body'] = null;
    const pt = parsePt(card.pt);
    const base = bodies.get(mvBucket(card.mv));
    if (pt && /Creature/.test(card.type) && base && base.length >= 3) {
      const avgP = mean(base.map((b) => b[0]));
      const avgT = mean(base.map((b) => b[1]));
      const delta = pt[0] + pt[1] - (avgP + avgT);
      body = { p: pt[0], t: pt[1], mv: mvBucket(card.mv), avgP, avgT, delta, verdict: delta >= 1 ? 'above' : delta <= -1 ? 'below' : 'typical' };
    }

    const keywords = KEYWORDS.filter((k) => new RegExp(`(^|\\n|, )${k}\\b`, 'i').test(text));
    const wants = HOOKS.flatMap(({ hook, test }) => {
      const m = text.match(test);
      return m ? [{ hook, why: m[0] }] : [];
    });

    let timing: CardFacts['timing'] = null;
    if (row && row.values.oh !== null && row.values.gd !== null && !row.lowSample) {
      const rel = row.values.gd - row.values.oh - (timingGap.get(mvBucket(card.mv)) ?? overallGap);
      timing = { oh: row.values.oh, gd: row.values.gd, rel, mv: mvBucket(card.mv), verdict: rel >= 1.5 ? 'late' : rel <= -1.5 ? 'early' : 'even' };
    }

    const lift = row && row.values.iwd !== null && !row.lowSample ? { iwd: row.values.iwd, setAvg: setIwd } : null;

    const pairs = pairRows
      .filter(({ pair }) => card.colors.every((c) => pair.includes(c)))
      .flatMap(({ pair, pr, avg }) => {
        const r = pr.get(card.name);
        if (!r || r.lowSample || r.values.gih === null) return [];
        return [{ pair, gih: r.values.gih, rel: r.values.gih - avg, games: r.values.games ?? 0 }];
      })
      .sort((a, b) => b.rel - a.rel);

    let demand: CardFacts['demand'] = null;
    if (row && row.values.ata !== null && row.values.gih !== null && !row.lowSample) {
      const winZ = (row.values.gih - winMean) / winSd;
      const pickZ = -(row.values.ata - ataMean) / ataSd;
      // The pick a card with this win rate usually goes at.
      const fairAta = Math.max(1, Math.min(14, ataMean - winZ * ataSd));
      const gap = pickZ - winZ;
      // Judge in picks, not standard deviations: a 2-pick gap is one a drafter
      // can act on, and a first pick cannot be taken any earlier.
      const picks = fairAta - row.values.ata;
      const verdict = picks >= 2 ? 'overdrafted' : picks <= -2 ? 'underrated' : 'fair';
      demand = { ata: row.values.ata, fairAta, gap, verdict };
    }

    out.set(card.name, {
      name: card.name,
      body,
      keywords,
      roles: (card.roles ?? []).map((r) => r.role),
      wants,
      timing,
      lift,
      pairs,
      demand,
      games: row?.values.games ?? 0,
      lowSample: row?.lowSample ?? true,
    });
  }
  return out;
}

const PAIR_NAMES: Record<string, string> = {
  WU: 'white-blue', UB: 'blue-black', BR: 'black-red', RG: 'red-green', WG: 'green-white',
  WB: 'white-black', UR: 'blue-red', BG: 'black-green', WR: 'red-white', UG: 'green-blue',
};
export const pairName = (pair: string) => PAIR_NAMES[pair] ?? pair;

const pts = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;

/**
 * The facts in short plain-English lines, for the card notes and drill explanations. Short on
 * purpose (Ken 2026-11-14: "remove text redundancy ... reads easier"): the card itself shows its
 * size and cost, and the stat bars show the raw numbers, so a line only says what is new.
 */
export function factLines(f: CardFacts, setCode: string): { label: string; text: string }[] {
  const lines: { label: string; text: string }[] = [];
  if (f.body) {
    const { p, t, avgP, avgT, mv } = f.body;
    const most = `most ${mv}-drops (typical ${avgP.toFixed(1)}/${avgT.toFixed(1)})`;
    const dp = p - avgP;
    const dt = t - avgT;
    let text: string;
    if (dp >= 1 && dt <= -1) text = `More power, less toughness than ${most}.`;
    else if (dt >= 1 && dp <= -1) text = `More toughness, less power than ${most}.`;
    else if (f.body.verdict === 'above') text = `Bigger than ${most}.`;
    else if (f.body.verdict === 'below') text = `Smaller than ${most}.`;
    else text = `About the size of ${most}.`;
    lines.push({ label: 'Body', text });
  }
  if (f.keywords.length) lines.push({ label: 'Keywords', text: f.keywords.join(', ') });
  if (f.wants.length) {
    const w = f.wants.map((x) => x.hook).join(', ');
    lines.push({ label: 'Wants', text: w.charAt(0).toUpperCase() + w.slice(1) });
  }
  if (f.timing && f.timing.verdict !== 'even') {
    // rel: how much more (late) or less (early) it gains from opening hand to drawn later than its peers.
    const by = `${Math.abs(f.timing.rel).toFixed(1)} pts more than most ${f.timing.mv}-drops`;
    lines.push({ label: 'Timing', text: f.timing.verdict === 'early' ? `Best in the opening hand (${by}).` : `Best drawn late (${by}).` });
  }
  if (f.pairs.length >= 2) {
    const best = f.pairs[0];
    const worst = f.pairs[f.pairs.length - 1];
    const avgRel = mean(f.pairs.map((p) => p.rel));
    // Under a 3-point spread, "best" and "worst" would be noise.
    lines.push({
      label: 'Decks',
      text:
        best.rel - worst.rel < 3
          ? `${avgRel > 1 ? 'Strong' : avgRel < -1 ? 'Weak' : 'About average'} in every deck it fits.`
          : `Best in ${pairName(best.pair)}, weakest in ${pairName(worst.pair)}.`,
    });
  } else if (f.pairs.length === 1) {
    lines.push({ label: 'Decks', text: `Plays in ${pairName(f.pairs[0].pair)} (${pts(f.pairs[0].rel)} vs. other cards there).` });
  }
  if (f.demand && f.demand.verdict !== 'fair') {
    lines.push({
      label: f.demand.verdict === 'overdrafted' ? 'Overdrafted' : 'Underrated',
      text: `Taken at pick ${f.demand.ata.toFixed(1)}, wins like a pick-${Math.max(1, Math.round(f.demand.fairAta))} card.`,
    });
  }
  if (f.lowSample) lines.push({ label: 'Sample', text: `Only ${f.games} games: read loosely.` });
  return lines;
}
