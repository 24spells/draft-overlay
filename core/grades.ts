// The 17Lands grade scale. An average card is a C; each step is one third of
// a standard deviation.

export const LADDER = [
  'F', 'D-', 'D', 'D+', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+',
] as const;

export type Grade = (typeof LADDER)[number];

export function gradeIndex(z: number): number {
  const index = Math.floor(3 * (z + 2 - 1 / 6));
  return Math.max(0, Math.min(LADDER.length - 1, index));
}

export function gradeFromZ(z: number): Grade {
  return LADDER[gradeIndex(z)];
}

/** Grade as a 0-5 score, for the alternative display style. */
export function gradeScore(index: number): number {
  return (index / (LADDER.length - 1)) * 5;
}

/**
 * Mean and population standard deviation, each card counting equally.
 * Returns null below 15 cards, where 17Lands gives no grades.
 */
export function distribution(
  values: number[],
): { mean: number; sd: number } | null {
  const n = values.length;
  if (n < 15) {
    return null;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const sd = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n,
  );
  return sd > 0 ? { mean, sd } : null;
}
