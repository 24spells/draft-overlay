// The coach hint, same as the web trainer's (2026-11-13): outline the
// coach's top 3 in the pack, unranked. Runs the trainer's own engine (coach/,
// copied by scripts/sync-coach.mjs) on the trainer's own set file, flow
// baseline and shape prices, so the overlay and 23spells agree.

import { buildDraftCards, type DraftCard } from '../coach/bot.ts';
import { buildCoachModel, evaluatePack, type CoachCard, type CoachModel } from '../coach/engine.ts';
import { feederOf, readFlow, type FlowBaseline } from '../coach/flow.ts';
import { rateSet } from '../core/stats.ts';
import type { CoachData, DraftView, SetStats } from '../core/types.ts';

export type Coach = {
  set: string;
  model: CoachModel;
  draftCards: DraftCard[];
  flow: FlowBaseline | null;
  /** Card name -> index in the trainer's card list. */
  byName: Map<string, number>;
};

/** Built once per set file: the same model the trainer builds at startup (App.svelte). */
export function createCoach(data: CoachData): Coach | null {
  const file = data.set as { set: string; cards: CoachCard[]; stats: SetStats; estimates?: Record<string, { gih: number }> };
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
  const shapeTax = (data.builds as { shapeTax?: Record<string, number[]> } | null)?.shapeTax ?? null;
  return {
    set: file.set,
    model: buildCoachModel(file.cards, file.stats, est, shapeTax as never, (data.splash ?? null) as never),
    draftCards: buildDraftCards(file.cards as never, rows),
    flow: (data.flow as FlowBaseline | null) ?? null,
    byName: new Map(file.cards.map((card, index) => [card.name, index])),
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
export const overallPick = (view: DraftView) => (view.packNumber - 1) * 14 + (view.pickNumber - 1);

/**
 * The Arena card ids the coach outlines: the top 3 by the engine's evaluation
 * (never the whole pack: the last card alone is not a hint), like the trainer.
 */
export function topThree(coach: Coach, view: DraftView, names: (id: number) => string | undefined, memory: PackMemory): Set<number> {
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
    return new Set();
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
  const { evals } = evaluatePack(coach.model, pack, pool, overallPick(view), flow);
  const top = evals.slice(0, Math.min(3, evals.length - 1)).map((e) => e.index);
  return new Set(top.flatMap((ix) => idsByIndex.get(ix) ?? []));
}
