// COPIED from draft-trainer/src/lib/deck.ts by scripts/sync-coach.mjs. Do not edit here;
// change the trainer and rerun the sync.

// Deck building: which pool cards are in the main deck, how many basics,
// and the numbers the builder shows (curve, interaction, mana check).

import { INTERACTION, type Role } from './roles.ts';
import type { Card } from '../core/types.ts';

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export type Color = (typeof COLORS)[number];

export const COLOR_NAMES: Record<Color, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
};

export const BASIC_NAMES: Record<Color, string> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest',
};

export type Deck = {
  /** Positions in the player's pool (0-41) that are in the main deck. */
  main: number[];
  basics: Record<Color, number>;
};

export const emptyDeck = (): Deck => ({ main: [], basics: { W: 0, U: 0, B: 0, R: 0, G: 0 } });

export const DECK_SIZE = 40;
/**
 * Lands per 40 cards: 16 in both formats (scripts/coach-knobs.ts, skill-adjusted, card quality held
 * fixed). Sealed (2026-11-14, Ken approved): 16 beat 17 by +0.74 pts in 27/30 sets; low curves +1.2,
 * top-heavy +0.3. Draft (2026-11-14, Ken: "whatever the bot thinks"): 16 beat 17 by +1.52 pts in 33/34
 * sets, 884k decks; low curves +1.74, top-heavy (5+ cards at 5+ mana) +1.03 in 30/34. No curve favors
 * 17, so no curve rule. LAND_TARGET is the fallback before a set loads; lib/set.ts sets the live one.
 */
export const LAND_TARGET = 16;
let landTargetNow = LAND_TARGET;
export function setLandTarget(n: number): void {
  landTargetNow = n;
}
export function landTarget(): number {
  return landTargetNow;
}

export const isLand = (card: Card) => card.type.includes('Land');
export const isCreature = (card: Card) => card.type.includes('Creature');

/** Mana-value column for the deck view: 1 or less, 2, 3, 4, 5, 6 or more. */
export function mvColumn(card: Card): number {
  return Math.max(1, Math.min(6, Math.floor(card.mv)));
}

/** Colored mana symbols in a cost. Hybrid symbols count half to each color. */
export function pips(cost: string): Record<Color, number> {
  const out: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  // Double-faced cards: only the front face's cost is paid to cast it.
  const front = cost.split(' // ')[0];
  for (const match of front.matchAll(/\{([^}]+)\}/g)) {
    const parts = match[1].split('/').filter((p) => p !== 'P' && (COLORS as readonly string[]).includes(p));
    for (const p of parts) out[p as Color] += 1 / parts.length;
  }
  return out;
}

/**
 * Card frames in the builder. The overlap colors are the app standard for
 * comparing two decks from one pool: add = in both (green), cut = only yours
 * (red), theirs = only the reference deck (blue).
 */
export type MarkTone = 'cut' | 'add' | 'off' | 'focus' | 'hint' | 'theirs';

/** What a cost demands (front face only): colors needed outright, and hybrid choices (any one of each). */
export function colorNeeds(cost: string): { must: Color[]; either: Color[][] } {
  const must = new Set<Color>();
  const either: Color[][] = [];
  for (const match of cost.split(' // ')[0].matchAll(/\{([^}]+)\}/g)) {
    const parts = match[1].split('/').filter((p) => (COLORS as readonly string[]).includes(p)) as Color[];
    if (parts.length === 1) must.add(parts[0]);
    else if (parts.length >= 2) either.push(parts);
  }
  return { must: [...must], either };
}

/**
 * Can a deck in these colors cast the card? Reads the cost (front face): every
 * outright color must be there, and each hybrid symbol needs one of its
 * options. A {U/R} card is castable in Blue-Black. Cards with no colored
 * symbols fall back to their colors (colorless artifacts: always).
 */
export function castableIn(card: { cost?: string; colors: string[] }, colors: readonly string[]): boolean {
  const { must, either } = colorNeeds(card.cost ?? '');
  if (!must.length && !either.length) return card.colors.every((c) => colors.includes(c));
  return must.every((c) => colors.includes(c)) && either.every((opts) => opts.some((c) => colors.includes(c)));
}

/** Colors a nonbasic land (or mana rock) can make, read from its text. */
export function landColors(card: Card): Color[] {
  if (/any color|the chosen color/i.test(card.text)) return [...COLORS];
  const out = new Set<Color>();
  for (const line of card.text.split('\n')) {
    if (!/\badd\b/i.test(line)) continue;
    for (const m of line.matchAll(/\{([WUBRG])\}/g)) out.add(m[1] as Color);
  }
  return [...out];
}

export type DeckStats = {
  spells: number;
  lands: number;
  total: number;
  creatures: number;
  noncreature: number;
  curve: { mv: number; creatures: number; other: number }[];
  roles: Partial<Record<Role, number>>;
  interaction: number;
  pips: Record<Color, number>;
  sources: Record<Color, number>;
  colors: Color[];
  /** Plain warnings about the mana: too few sources for a color, or a share mismatch. */
  manaFlags: string[];
};

export function deckStats(deck: Deck, pool: number[], cards: Card[]): DeckStats {
  const main = deck.main.map((pos) => cards[pool[pos]]);
  const spells = main.filter((c) => !isLand(c));
  const nonbasicLands = main.filter((c) => isLand(c));
  const basics = COLORS.reduce((s, c) => s + deck.basics[c], 0);

  const curve = [1, 2, 3, 4, 5, 6].map((mv) => {
    const at = spells.filter((c) => mvColumn(c) === mv);
    return { mv, creatures: at.filter(isCreature).length, other: at.filter((c) => !isCreature(c)).length };
  });

  const roles: Partial<Record<Role, number>> = {};
  let interaction = 0;
  for (const card of main) {
    for (const r of card.roles ?? []) roles[r.role] = (roles[r.role] ?? 0) + 1;
    if ((card.roles ?? []).some((r) => INTERACTION.includes(r.role))) interaction += 1;
  }

  const pipTotals: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const card of spells) {
    const p = pips(card.cost);
    for (const c of COLORS) pipTotals[c] += p[c];
  }
  const sources: Record<Color, number> = { ...deck.basics };
  for (const land of nonbasicLands) for (const c of landColors(land)) sources[c] += 1;

  const colors = COLORS.filter((c) => pipTotals[c] > 0);
  const manaFlags: string[] = [];
  const pipSum = colors.reduce((s, c) => s + pipTotals[c], 0);
  const landCount = basics + nonbasicLands.length;
  for (const c of colors) {
    const cardsInColor = spells.filter((card) => pips(card.cost)[c] > 0).length;
    if (sources[c] === 0) {
      manaFlags.push(`No ${COLOR_NAMES[c]} sources for ${cardsInColor} ${COLOR_NAMES[c]} card${cardsInColor === 1 ? '' : 's'}.`);
    } else if (sources[c] < 3) {
      manaFlags.push(
        `Only ${sources[c]} ${COLOR_NAMES[c]} source${sources[c] === 1 ? '' : 's'} for ${cardsInColor} ${COLOR_NAMES[c]} card${cardsInColor === 1 ? '' : 's'}. A splash usually wants 3 or more.`,
      );
    } else if (landCount > 0 && pipSum > 0) {
      const pipShare = pipTotals[c] / pipSum;
      const sourceShare = sources[c] / landCount;
      if (Math.abs(pipShare - sourceShare) >= 0.15) {
        manaFlags.push(
          `${COLOR_NAMES[c]} is ${Math.round(pipShare * 100)}% of your colored symbols but ${Math.round(sourceShare * 100)}% of your lands.`,
        );
      }
    }
  }
  for (const c of COLORS) {
    if (deck.basics[c] > 0 && pipTotals[c] === 0) {
      manaFlags.push(`${deck.basics[c]} ${BASIC_NAMES[c]} but no ${COLOR_NAMES[c]} cards.`);
    }
  }

  return {
    spells: spells.length,
    lands: landCount,
    total: main.length + basics,
    creatures: spells.filter(isCreature).length,
    noncreature: spells.filter((c) => !isCreature(c)).length,
    curve,
    roles,
    interaction,
    pips: pipTotals,
    sources,
    colors,
    manaFlags,
  };
}

/**
 * Basics for the land target (16), split by colored symbols in the deck's spells
 * (largest remainder, at least one of each color used). Nonbasic lands in the
 * deck count toward the target.
 */
export function autoLands(deck: Deck, pool: number[], cards: Card[]): Record<Color, number> {
  const main = deck.main.map((pos) => cards[pool[pos]]);
  const nonbasic = main.filter(isLand).length;
  const toPlace = Math.max(0, landTargetNow - nonbasic);
  const totals: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const spells = main.filter((c) => !isLand(c));
  // A hybrid symbol is paid with a color the deck already plays (2026-11-14: a {G/U} card in a
  // Red-Green deck put an Island in), as deckMeasures counts colors; else it splits as before.
  const played = new Set(spells.flatMap((c) => colorNeeds(c.cost).must));
  for (const card of spells) {
    const p = pips(card.cost);
    for (const opts of colorNeeds(card.cost).either) {
      const pay = opts.find((o) => played.has(o));
      if (!pay) continue;
      for (const o of opts) p[o] -= 1 / opts.length;
      p[pay] += 1;
    }
    for (const c of COLORS) totals[c] += Math.max(0, p[c]);
  }
  const used = COLORS.filter((c) => totals[c] > 0);
  const out: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  if (used.length === 0 || toPlace === 0) return out;
  const sum = used.reduce((s, c) => s + totals[c], 0);
  const exact = used.map((c) => ({ c, x: (totals[c] / sum) * toPlace }));
  for (const e of exact) out[e.c] = Math.max(1, Math.floor(e.x));
  let placed = used.reduce((s, c) => s + out[c], 0);
  const byRemainder = [...exact].sort((a, b) => (b.x % 1) - (a.x % 1));
  for (let i = 0; placed < toPlace; i = (i + 1) % byRemainder.length) {
    out[byRemainder[i].c] += 1;
    placed += 1;
  }
  // The minimum of one can overshoot on many-color piles; trim the largest.
  while (placed > toPlace) {
    const largest = used.reduce((a, b) => (out[a] >= out[b] ? a : b));
    out[largest] -= 1;
    placed -= 1;
  }
  return out;
}

/** Arena import format. */
export function exportArena(deck: Deck, pool: number[], cards: Card[]): string {
  const count = (names: string[]) => {
    const m = new Map<string, number>();
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
    return [...m].map(([n, k]) => `${k} ${n}`);
  };
  const mainNames = deck.main.map((pos) => cards[pool[pos]].name);
  for (const c of COLORS) for (let i = 0; i < deck.basics[c]; i += 1) mainNames.push(BASIC_NAMES[c]);
  const inMain = new Set(deck.main);
  const side = pool.map((_, pos) => pos).filter((pos) => !inMain.has(pos)).map((pos) => cards[pool[pos]].name);
  return ['Deck', ...count(mainNames), '', 'Sideboard', ...count(side)].join('\n');
}

/**
 * The deck measured exactly like scripts/build-deck-benchmarks.ts measures
 * real decks, so the two compare like for like. Main colors: the two colors
 * with the most cards needing them; any other color used is a splash.
 */
export function deckMeasures(deck: Deck, pool: number[], cards: Card[]) {
  const main = deck.main.map((pos) => cards[pool[pos]]);
  const spells = main.filter((c) => !isLand(c));
  const has = (c: Card, role: Role) => (c.roles ?? []).some((r) => r.role === role);
  const interacts = (c: Card) => (c.roles ?? []).some((r) => INTERACTION.includes(r.role));

  // Colors: count each spell's outright needs (front face). A hybrid symbol
  // ({G/U}) adds no color when one of its options is already in the deck; it
  // used to count half to each and showed phantom splashes.
  const needs: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const hybrids: Color[][] = [];
  for (const c of spells) {
    const { must, either } = colorNeeds(c.cost);
    for (const col of must) needs[col] += 1;
    hybrids.push(...either);
  }
  const byNeed = () => COLORS.filter((c) => needs[c] > 0).sort((a, b) => needs[b] - needs[a]);
  for (const opts of hybrids) {
    if (opts.some((o) => needs[o] > 0)) continue;
    needs[opts[0]] += 1;
  }
  const used = byNeed();
  const mainColors = used.slice(0, 2);
  const splashColors = used.slice(2);

  const sources: Record<Color, number> = { ...deck.basics };
  for (const land of main.filter(isLand)) for (const c of landColors(land)) sources[c] += 1;
  const lands = main.filter(isLand).length + COLORS.reduce((s, c) => s + deck.basics[c], 0);

  return {
    lands,
    creatures: spells.filter(isCreature).length,
    cheap: spells.filter((c) => c.mv <= 2).length,
    twoDrops: spells.filter((c) => c.mv === 2).length,
    topEnd: spells.filter((c) => c.mv >= 5).length,
    avgMv: spells.length ? spells.reduce((s, c) => s + c.mv, 0) / spells.length : 0,
    interaction: main.filter(interacts).length,
    bombs: spells.filter((c) => c.bomb).length,
    /** Info only: rule-based threats did not predict winning beyond card quality. */
    threats: spells.filter((c) => has(c, 'threat')).length,
    removal: main.filter((c) => has(c, 'removal')).length,
    cardDraw: main.filter((c) => has(c, 'card draw')).length,
    evasion: main.filter((c) => has(c, 'evasion')).length,
    fixing: main.filter((c) => has(c, 'fixing')).length,
    colors: mainColors.length,
    splash: splashColors.length > 0 ? 1 : 0,
    mainSources: mainColors.length === 2 ? Math.min(sources[mainColors[0]], sources[mainColors[1]]) : mainColors.length === 1 ? sources[mainColors[0]] : 0,
    splashCards: spells.filter((c) => !castableIn(c, mainColors)).length,
    mainColors,
    splashColors,
    sources,
  };
}

export type DeckMeasures = ReturnType<typeof deckMeasures>;

/**
 * Categories you can spotlight in the builder: tap a count (in the profile or
 * the stats panel) and the matching cards stay lit while the rest dim. Each
 * test matches how deckMeasures / deckStats count, so the lit cards are the
 * number you tapped.
 */
const hasRole = (c: Card, role: Role) => (c.roles ?? []).some((r) => r.role === role);
const spell = (c: Card) => !isLand(c);
export const SPOTS: Record<string, { label: string; test: (c: Card) => boolean }> = {
  creatures: { label: 'Creatures', test: (c) => spell(c) && isCreature(c) },
  interaction: { label: 'Interaction', test: (c) => (c.roles ?? []).some((r) => INTERACTION.includes(r.role)) },
  twoDrops: { label: 'Two-drops', test: (c) => spell(c) && c.mv === 2 },
  cheap: { label: 'Spells costing 2 or less', test: (c) => spell(c) && c.mv <= 2 },
  topEnd: { label: 'Spells costing 5+', test: (c) => spell(c) && c.mv >= 5 },
  cardDraw: { label: 'Card draw', test: (c) => hasRole(c, 'card draw') },
  bombs: { label: 'Bombs', test: (c) => spell(c) && c.bomb === true },
  lands: { label: 'Lands', test: (c) => isLand(c) },
  threats: { label: 'Threats', test: (c) => spell(c) && hasRole(c, 'threat') },
};
/** Spotlight key for a role row: 'role:removal' and so on. */
export function spotTest(key: string): ((c: Card) => boolean) | null {
  if (key.startsWith('mv:')) {
    const mv = Number(key.slice(3));
    return (c) => !isLand(c) && mvColumn(c) === mv;
  }
  if (key.startsWith('role:')) {
    const role = key.slice(5) as Role;
    return (c) => hasRole(c, role);
  }
  // Rarity: 'rarity:common' / uncommon / rare / mythic (basics are not counted).
  if (key.startsWith('rarity:')) {
    const r = key.slice(7);
    return (c) => c.rarity === r && !c.type.startsWith('Basic');
  }
  return SPOTS[key]?.test ?? null;
}
