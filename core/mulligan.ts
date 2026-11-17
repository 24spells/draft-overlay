// Keep or mulligan, as information (Ken 2026-11-16: "the overlay never makes decisions, just gives information").
// At Arena's mulligan prompt the overlay shows two numbers: this hand's win chance if kept, and the average win
// chance after a mulligan, for this deck, on the play or draw. Never a Keep/Ship word.
//
// The models are trained and tested on 17Lands public data in the trainer repo
// (draft-trainer/scripts/statcast/mull_model.py, mull_all.py) and exported as gradient-boosted trees
// (export_mull.py). The feature code here mirrors that Python exactly; core-tests check parity on sample hands.

/** One card's facts. Index order matches export_mull.py. */
export type MullCard = [
  land: 0 | 1,
  makes: number, // bitmask W=1 U=2 B=4 R=8 G=16 (lands)
  pipW: number,
  pipU: number,
  pipB: number,
  pipR: number,
  pipG: number,
  mv: number,
  creature: 0 | 1,
  rare: 0 | 1, // rare or mythic
  q: number, // in-hand quality, win-rate points vs the set (0 when the set has no 17Lands data)
  oh: number, // keep value: opening-hand win rate, points vs the set (0 without data)
  lean: number, // fast (+) / slow (-) lean (0 without data)
];

/** sklearn HistGradientBoosting trees, flattened: per node feature, threshold, left, right, value, leaf, NaN-left. */
export type MullTree = { f: number[]; t: number[]; l: number[]; r: number[]; v: number[]; leaf: number[]; nl: number[] };
export type MullBooster = { features: string[]; base: number; trees: MullTree[] };

export type MullModel = {
  set: string;
  /** 'set': trained on this set's 17Lands data. 'pooled': no card data, trained on other sets. */
  kind: 'set' | 'pooled';
  keep: MullBooster;
  ship: MullBooster;
  /** Arena card id -> facts. */
  cards: Record<string, MullCard>;
  /** Quality at or above which a spell counts as a bomb (the set's top 5%). */
  bombQ: number;
  /** Land counts with too few kept examples to estimate (e.g. 0, 1, 6, 7). */
  thinLands: number[];
  /** Held-out check summary, shown as fine print. */
  tested: string;
};

export type MullRead = {
  /** Win chance if this seven is kept (0-1). */
  keep: number | null;
  /** Average win chance after a mulligan with this deck, on the play or draw (0-1). */
  ship: number;
  lands: number;
  /** A land count the model has too few kept examples for: show the mulligan number only. */
  thin: boolean;
  /** Cards in the hand the model does not know (e.g. a new printing): read loosely. */
  unknown: number;
  kind: MullModel['kind'];
};

const COLORS = [1, 2, 4, 8, 16];
const FALLBACK: MullCard = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function castable(c: MullCard, lands: MullCard[], budget: number): boolean {
  if (c[0] || c[7] <= 0 || c[7] > budget) return false;
  for (let i = 0; i < 5; i++) {
    const need = c[2 + i];
    if (need && lands.filter((l) => l[1] & COLORS[i]).length < need) return false;
  }
  return true;
}

/** All features the models use, by name (a model reads the ones it was trained on). */
/**
 * Basic lands by printing, for ids no card list has yet (Arena's Nov 2026 basics, seen in Ken's logs).
 * The game log also names basics as they appear (mull-live.ts); both feed basicFacts.
 */
export const KNOWN_BASICS: Record<string, string> = {
  '106895': 'W', '106897': 'U', '106899': 'B', '106901': 'R', '106903': 'G',
  '106531': 'B', '106533': 'R', '96180': 'W', '96182': 'U', '96185': 'B', '96188': 'R', '96191': 'G',
};
const MASK: Record<string, number> = { W: 1, U: 2, B: 4, R: 8, G: 16 };

/** A basic land's facts: copied from a basic of that color the model knows, else built plainly. */
function basicFacts(model: MullModel, color: string, basics: Record<string, string>): MullCard {
  for (const [id, c] of Object.entries({ ...KNOWN_BASICS, ...basics })) {
    if (c === color && model.cards[id]?.[0]) return model.cards[id];
  }
  return [1, MASK[color] ?? 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

export function mullFeatures(model: MullModel, hand: number[], deck: number[], onPlay: boolean, skill: number, basics: Record<string, string> = {}): {
  x: Record<string, number>;
  unknown: number;
} {
  let unknown = 0;
  const find = (id: number): MullCard | undefined => {
    const c = model.cards[String(id)];
    if (c) return c;
    const color = basics[String(id)] ?? KNOWN_BASICS[String(id)];
    return color ? basicFacts(model, color, basics) : undefined;
  };
  const look = (id: number): MullCard => {
    const c = find(id);
    if (!c) unknown++;
    return c ?? FALLBACK;
  };
  const h = hand.map(look);
  const known = unknown;
  const d = deck.map((id) => find(id) ?? FALLBACK);
  unknown = known;
  const lands = h.filter((c) => c[0]);
  const sp = h.filter((c) => !c[0]);
  const makes = lands.reduce((m, l) => m | l[1], 0);
  const n = Math.max(1, sp.length);
  const ds = d.filter((c) => !c[0]);
  const dn = Math.max(1, ds.length);
  const sum = (a: MullCard[], i: number) => a.reduce((s, c) => s + c[i], 0);
  const x: Record<string, number> = {
    on_play: onPlay ? 1 : 0,
    skill,
    lands7: lands.length,
    spells7: sp.length,
    cheap7: sp.filter((c) => c[7] <= 2).length,
    cast2: sp.filter((c) => castable(c, lands, Math.min(2, lands.length))).length,
    cast3: sp.filter((c) => castable(c, lands, Math.min(3, lands.length))).length,
    offcolor: sp.filter((c) => [0, 1, 2, 3, 4].some((i) => c[2 + i] > 0 && !(makes & COLORS[i]))).length,
    mv7: sum(sp, 7) / n,
    cre7: sp.filter((c) => c[8]).length,
    rare7: sp.filter((c) => c[9]).length,
    q7: sum(sp, 10) / n,
    oh7: sum(sp, 11) / n,
    best7: sp.length ? Math.max(...sp.map((c) => c[10])) : 0,
    bombs7: sp.filter((c) => c[10] >= model.bombQ).length,
    deck_q: sum(ds, 10) / dn,
    deck_lean: sum(ds, 12) / dn,
    deck_mv: sum(ds, 7) / dn,
    deck_cre: ds.filter((c) => c[8]).length,
    deck_lands: d.length - ds.length,
  };
  return { x, unknown };
}

/** Win probability from a booster: sigmoid(base + sum of leaf values). Missing values follow the trained NaN branch. */
export function predict(b: MullBooster, x: Record<string, number>): number {
  const row = b.features.map((f) => (f in x ? x[f] : NaN));
  let raw = b.base;
  for (const t of b.trees) {
    let i = 0;
    while (!t.leaf[i]) {
      const v = row[t.f[i]];
      i = Number.isNaN(v) ? (t.nl[i] ? t.l[i] : t.r[i]) : v <= t.t[i] ? t.l[i] : t.r[i];
    }
    raw += t.v[i];
  }
  return 1 / (1 + Math.exp(-raw));
}

/** The read for the first seven at the mulligan prompt. */
export function mullRead(model: MullModel, hand: number[], deck: number[], onPlay: boolean, skill = 0.55, basics: Record<string, string> = {}): MullRead {
  const { x, unknown } = mullFeatures(model, hand, deck, onPlay, skill, basics);
  const thin = model.thinLands.includes(x.lands7);
  return {
    keep: thin ? null : predict(model.keep, x),
    ship: predict(model.ship, x),
    lands: x.lands7,
    thin,
    unknown,
    kind: model.kind,
  };
}
