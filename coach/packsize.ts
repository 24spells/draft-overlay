// COPIED from draft-trainer/src/lib/packsize.ts by scripts/sync-coach.mjs. Do not edit here;
// change the trainer and rerun the sync.

// Cards per pack for the set in play. Most sets draft 14-card packs on Arena, but
// not all (2026-11-13 backfill: ECL, BLB, MKM 13; LCI, PIO 15), so pick numbers,
// pack boundaries and "picks left" all come from here instead of a literal 14.
// One set is active at a time: the app sets it in loadSet, scripts from the set file.

let size = 14;

/** Cards per pack (14 unless the set says otherwise). */
export const packSize = () => size;
/** Picks in a whole draft: three packs. */
export const totalPicks = () => size * 3;
/** Overall pick number (0-based) from pack round and pick within the pack. */
export const overallOf = (round: number, pick: number) => round * size + pick;
/** Which pack round an overall pick falls in. */
export const roundOf = (overall: number) => Math.floor(overall / size);
/** Pick within its pack (0-based). */
export const pickInPack = (overall: number) => overall % size;

export function setPackSize(n: number) {
  if (Number.isInteger(n) && n >= 8 && n <= 20) size = n;
}

/** The most common pack length among real packs (a few odd packs show up in every file). */
export function packSizeFrom(packs: { length: number }[] | undefined): number {
  const counts = new Map<number, number>();
  for (const p of packs ?? []) counts.set(p.length, (counts.get(p.length) ?? 0) + 1);
  let best = 14, n = 0;
  for (const [len, c] of counts) if (c > n) { best = len; n = c; }
  return best;
}
