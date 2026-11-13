import { distribution, gradeIndex, LADDER } from './grades.ts';
import type { Block, PickStat, SetStats } from './types.ts';

export type MetricId =
  | 'gih' | 'oh' | 'gd' | 'gp' | 'gns' | 'iwd' | 'games' | 'ata' | 'alsa';

export type GradeBasis = 'gih' | 'oh' | 'gd';

export const METRICS: Record<
  MetricId,
  { short: string; label: string; name: string }
> = {
  gih: { short: 'GIH', label: 'GIH WR: win rate when in hand', name: 'When in hand' },
  oh: { short: 'OH', label: 'OH WR: win rate in opening hand', name: 'In opening hand' },
  gd: { short: 'GD', label: 'GD WR: win rate when drawn later', name: 'When drawn later' },
  gp: { short: 'GP', label: 'GP WR: win rate when in the deck', name: 'When in deck' },
  gns: { short: 'GNS', label: 'GNS WR: win rate in deck, never seen', name: 'When never drawn' },
  iwd: { short: 'IWD', label: 'IWD: GIH WR minus GNS WR', name: 'Improvement when drawn' },
  games: { short: 'GMS', label: 'Games in hand (sample size)', name: 'Games in hand' },
  ata: { short: 'ATA', label: 'ATA: average pick taken at', name: 'Average pick taken at' },
  alsa: { short: 'ALSA', label: 'ALSA: average pick last seen at', name: 'Average pick last seen at' },
};

export const METRIC_IDS = Object.keys(METRICS) as MetricId[];

export const COLOR_PAIRS = [
  'WU', 'UB', 'BR', 'RG', 'WG', 'WB', 'UR', 'BG', 'WR', 'UG',
];

export const BASICS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);

export type RateOptions = {
  deck: string;
  players: string;
  basis: GradeBasis;
  minGames: number;
};

export type CardRow = {
  name: string;
  values: Record<MetricId, number | null>;
  gradeIndex: number | null;
  grade: string | null;
  lowSample: boolean;
};

function winRate(block: Block | 0, offset: number): number | null {
  // wins = -1 marks a win rate the source hid (17Lands' site hides small samples).
  if (block === 0 || block[offset] === 0 || block[offset + 1] < 0) {
    return null;
  }
  return (block[offset + 1] / block[offset]) * 100;
}

function metricValues(
  block: Block | 0,
  pick: PickStat | 0,
): Record<MetricId, number | null> {
  const gih = winRate(block, 4);
  const gns = winRate(block, 8);
  return {
    oh: winRate(block, 0),
    gd: winRate(block, 2),
    gih,
    gp: winRate(block, 6),
    gns,
    iwd: gih !== null && gns !== null ? gih - gns : null,
    games: block === 0 ? 0 : block[4],
    ata: pick === 0 || pick[1] === 0 ? null : pick[0],
    alsa: pick === 0 || pick[3] === 0 ? null : pick[2],
  };
}

/** Stats and grades for every card, under one set of filters. */
export function rateSet(
  set: SetStats,
  options: RateOptions,
): Map<string, CardRow> {
  const group = set.groups[`${options.deck}|${options.players}`];
  const picks = set.picks[options.players] ?? [];
  const rows = new Map<string, CardRow>();

  set.names.forEach((name, index) => {
    const values = metricValues(group?.blocks[index] ?? 0, picks[index] ?? 0);
    rows.set(name, {
      name,
      values,
      gradeIndex: null,
      grade: null,
      lowSample: (values.games ?? 0) < options.minGames,
    });
  });

  const graded = [...rows.values()].filter(
    (row) =>
      !row.lowSample &&
      row.values[options.basis] !== null &&
      !BASICS.has(row.name),
  );
  const stats = distribution(graded.map((row) => row.values[options.basis]!));
  if (stats) {
    for (const row of graded) {
      row.gradeIndex = gradeIndex(
        (row.values[options.basis]! - stats.mean) / stats.sd,
      );
      row.grade = LADDER[row.gradeIndex];
    }
  }

  return rows;
}

/** The average card for each stat, over the same cards that get graded. */
export function averageValues(
  rows: Map<string, CardRow>,
): Record<MetricId, number | null> {
  const pool = [...rows.values()].filter(
    (row) => !row.lowSample && !BASICS.has(row.name),
  );
  const average = (metric: MetricId): number | null => {
    const values = pool
      .map((row) => row.values[metric])
      .filter((value): value is number => value !== null);
    return values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  };
  return Object.fromEntries(
    METRIC_IDS.map((metric) => [metric, average(metric)]),
  ) as Record<MetricId, number | null>;
}

export function formatMetric(metric: MetricId, value: number | null): string {
  if (value === null) {
    return '-';
  }
  if (metric === 'iwd') {
    const fixed = value.toFixed(1);
    if (fixed === '0.0' || fixed === '-0.0') {
      return '0.0';
    }
    return value > 0 ? `+${fixed}` : fixed;
  }
  if (metric === 'games') {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  }
  return value.toFixed(1);
}

/**
 * The two colors most represented in the picks so far, or null if it is too
 * early to tell. Picks with no color (lands, artifacts) do not count.
 */
export function autoDeck(set: SetStats, pickedIds: number[]): string | null {
  const counts = new Map<string, number>();
  let colored = 0;

  for (const id of pickedIds) {
    const card = set.cards[String(id)];
    if (!card || card.isLand || card.color.length === 0) {
      continue;
    }
    colored += 1;
    for (const color of card.color) {
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }

  if (colored < 6 || counts.size < 2) {
    return null;
  }

  const top = [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 2)
    .map(([color]) => color);

  return (
    COLOR_PAIRS.find((pair) => top.every((color) => pair.includes(color))) ??
    null
  );
}
