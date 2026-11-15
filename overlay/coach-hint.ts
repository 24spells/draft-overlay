// The coach hint, same as the web trainer's (2026-11-13): outline the
// coach's top 3 in the pack, unranked. Runs the trainer's own engine (coach/,
// copied by scripts/sync-coach.mjs) on the trainer's own set file, flow
// baseline and shape prices, so the overlay and 24spells agree.

import { buildDraftCards, type DraftCard } from '../coach/bot.ts';
import { packSize, packSizeFrom, setPackSize } from '../coach/packsize.ts';
import { buildCoachModel, evaluatePack, gradePick, type Badge, type CoachCard, type CoachModel, type PairOdds, type ShapeOdds } from '../coach/engine.ts';
import { feederOf, readFlow, type FlowBaseline } from '../coach/flow.ts';
import { buildFacts, type CardFacts, type FactCard } from '../coach/facts.ts';
import { tagRoles, type Role } from '../coach/roles.ts';
import { rateSet } from '../core/stats.ts';
import type { CoachData, DraftView, SetStats } from '../core/types.ts';

export type Coach = {
  set: string;
  model: CoachModel;
  draftCards: DraftCard[];
  flow: FlowBaseline | null;
  /** Card name -> index in the trainer's card list. */
  byName: Map<string, number>;
  /** The hover panel's card notes, built exactly as the site builds them (set.ts). */
  facts: Map<string, CardFacts>;
  /** What each card does (Removal, Card draw...), the site's role chips. */
  roles: Map<string, { role: Role; why: string }[]>;
};

/** Built once per set file: the same model the trainer builds at startup (App.svelte). */
export function createCoach(data: CoachData): Coach | null {
  const file = data.set as { set: string; cards: CoachCard[]; stats: SetStats; estimates?: Record<string, { gih: number }>; packs?: number[][] };
  // 13-, 14- or 15-card packs: the coach counts picks by the set's real pack size.
  setPackSize(packSizeFrom(file.packs));
  if (!file?.cards?.length || !file.stats) {
    return null;
  }
  const est = file.estimates ?? {};
  // Same rating and early-set estimates the trainer gives its bots (and so its flow read).
  const rows = rateSet(file.stats, { deck: 'ALL', players: 'all', basis: 'gih', minGames: 500 });
  for (const [name, e] of Object.entries(est)) {
    const row = rows.get(name);
    if (row && row.values.gih === null) {
      rows.set(name, { ...row, values: { ...row.values, gih: e.gih, games: 300 } });
    }
  }
  // The card notes: the site's facts on the site's default rating (all decks, all players).
  const factCards = (file.cards as unknown as FactCard[]).map((card) => ({ ...card, roles: tagRoles(card) }));
  const factRows = rateSet(file.stats, { deck: 'ALL', players: 'all', basis: 'gih', minGames: 500 });
  const shapeTax = (data.builds as { shapeTax?: Record<string, number[]> } | null)?.shapeTax ?? null;
  return {
    set: file.set,
    model: buildCoachModel(file.cards, file.stats, est, shapeTax as never, (data.splash ?? null) as never),
    draftCards: buildDraftCards(file.cards as never, rows),
    flow: (data.flow as FlowBaseline | null) ?? null,
    byName: new Map(file.cards.map((card, index) => [card.name, index])),
    facts: buildFacts(factCards, factRows, file.stats),
    roles: new Map(factCards.map((card) => [card.name, card.roles])),
  };
}

type Seen = { round: number; pick: number; shown: number[]; taken: number };

/**
 * Packs seen so far in each draft, for the flow read (which colors are coming
 * your way). Arena shows a pack once per pick, so this fills as you draft.
 */
export class PackMemory {
  private draftId: string | null = null;
  private seen = new Map<number, Seen>();

  record(view: DraftView, shown: number[]): void {
    if (view.draftId !== this.draftId) {
      this.draftId = view.draftId;
      this.seen.clear();
    }
    const overall = overallPick(view);
    this.seen.set(overall, { round: view.packNumber - 1, pick: view.pickNumber - 1, shown, taken: -1 });
  }

  /** Every earlier pick's pack, in order (the trainer's draft.log). */
  before(view: DraftView): Seen[] {
    const overall = overallPick(view);
    return [...this.seen.entries()].filter(([at]) => at < overall).sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  }
}

/** 0-based overall pick, the trainer's round x 14 + pick. */
export const overallPick = (view: DraftView) => (view.packNumber - 1) * packSize() + (view.pickNumber - 1);

/** The coach's top 3, as a set of Arena card ids (the trainer's unranked hint). */
export function topThree(coach: Coach, view: DraftView, names: (id: number) => string | undefined, memory: PackMemory): Set<number> {
  return new Set(coachRead(coach, view, names, memory, 3).ranks.keys());
}

/** Back-compat: Arena card id -> rank. */
export function coachRanks(coach: Coach, view: DraftView, names: (id: number) => string | undefined, memory: PackMemory, count = 3): Map<number, number> {
  return new Map([...coachRead(coach, view, names, memory, count).ranks].map(([id, r]) => [id, r.rank]));
}

/** What the engine saw for one pack: enough to grade the pick you then make. */
export type PackInput = { draftId: string | null; overall: number; pack: number[]; pool: number[]; flow?: Record<string, number>; picked: number[] };

export type CoachRead = {
  /** Arena card id -> rank (1 = best; copies share a rank) and win-rate points behind #1. */
  ranks: Map<number, { rank: number; gap: number }>;
  /** Your likely colors (pairs), and deck shapes (pair, splash, 3-4 colors). */
  odds: PairOdds;
  shapes: ShapeOdds;
  input: PackInput | null;
};

/**
 * The coach's read of the pack in front of you: its top picks best first (never
 * the whole pack: the last card is not a hint), how far each is behind #1, and
 * your likely colors. The same engine call as the trainer's hint.
 */
export function coachRead(coach: Coach, view: DraftView, names: (id: number) => string | undefined, memory: PackMemory, count = 3): CoachRead {
  const index = (id: number) => {
    const name = names(id);
    return name === undefined ? undefined : coach.byName.get(name);
  };
  const pack: number[] = [];
  const idsByIndex = new Map<number, number[]>();
  for (const id of view.cardIds) {
    const ix = index(id);
    if (ix === undefined) continue;
    pack.push(ix);
    idsByIndex.set(ix, [...(idsByIndex.get(ix) ?? []), id]);
  }
  memory.record(view, pack);
  if (pack.length < 2) {
    return { ranks: new Map(), odds: [], shapes: [], input: null };
  }
  const pool = view.pickedCardIds.map(index).filter((ix): ix is number => ix !== undefined);
  const round = view.packNumber - 1;
  const flow = coach.flow
    ? Object.fromEntries(
        readFlow({ log: memory.before(view) } as never, coach.draftCards, coach.flow, feederOf(round), {
          pack,
          round,
          pick: view.pickNumber - 1,
        }).colors.map((c) => [c.color, c.score]),
      )
    : undefined;
  const overall = overallPick(view);
  const { evals, odds, shapes } = evaluatePack(coach.model, pack, pool, overall, flow);
  const ranks = new Map<number, { rank: number; gap: number }>();
  const best = evals[0]?.ev ?? 0;
  const top = [...new Set(evals.map((e) => e.index))].slice(0, Math.min(count, evals.length - 1));
  top.forEach((ix, k) => {
    const gap = best - (evals.find((e) => e.index === ix)?.ev ?? best);
    for (const id of idsByIndex.get(ix) ?? []) ranks.set(id, { rank: k + 1, gap });
  });
  return { ranks, odds, shapes, input: { draftId: view.draftId, overall, pack, pool, flow, picked: [...view.pickedCardIds] } };
}

export type PickResult = { badge: Badge; loss: number; accuracy: number; best: string; taken: string };

/**
 * Grade the pick you made from a pack the coach read: the trainer's chess-style
 * grade (points given up vs the coach's best, late picks counting half).
 * `next` is the following pick's view; the taken card is the one new in your picks.
 */
export function gradeTaken(coach: Coach, input: PackInput, next: DraftView, names: (id: number) => string | undefined): PickResult | null {
  if (next.draftId !== input.draftId || overallPick(next) !== input.overall + 1) return null;
  const left = new Map<number, number>();
  for (const id of next.pickedCardIds) left.set(id, (left.get(id) ?? 0) + 1);
  for (const id of input.picked) left.set(id, (left.get(id) ?? 0) - 1);
  const takenId = [...left].find(([, n]) => n > 0)?.[0];
  if (takenId === undefined) return null;
  const name = names(takenId);
  const taken = name === undefined ? undefined : coach.byName.get(name);
  if (taken === undefined || !input.pack.includes(taken)) return null;
  const g = gradePick(coach.model, input.pack, input.pool, input.overall, taken, input.flow);
  return { badge: g.badge, loss: g.loss, accuracy: g.accuracy, best: coach.model.cards[g.best.index].name, taken: coach.model.cards[taken].name };
}
