// COPIED from draft-trainer/src/draft/rng.ts by scripts/sync-coach.mjs. Do not edit here;
// change the trainer and rerun the sync.

// Small seeded random numbers, so a draft can be saved and resumed exactly.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh generator for one moment in the draft, from the draft's seed. */
export function rngFor(seed: number, ...parts: number[]): Rng {
  let h = seed >>> 0;
  for (const p of parts) {
    h = Math.imul(h ^ (p + 0x9e3779b9), 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
  }
  return mulberry32(h);
}

/** Standard normal sample (Box-Muller). */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function shuffle<T>(items: T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
