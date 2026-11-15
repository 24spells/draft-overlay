// Copies the web trainer's pick coach into coach/, so the overlay's coach hint
// runs the exact same logic as the trainer (2026-11-13: "a companion to
// the web app"). Rerun after the trainer's coach changes, then build-app.
//
//   node scripts/sync-coach.mjs [path to the draft-trainer repo]
//
// Default trainer path: a sibling folder named draft-trainer. Stats and grades
// come from this repo's own core/ (the same math as the trainer's copy).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TRAINER = path.resolve(process.argv[2] ?? path.join(ROOT, '..', 'draft-trainer'));
const OUT = path.join(ROOT, 'coach');

/** Trainer file -> file here, and how its imports map. */
const FILES = [
  ['src/coach/engine.ts', 'engine.ts'],
  ['src/core/roles.ts', 'roles.ts'],
  ['src/lib/deck.ts', 'deck.ts'],
  ['src/lib/flow.ts', 'flow.ts'],
  ['src/draft/bot.ts', 'bot.ts'],
  ['src/draft/rng.ts', 'rng.ts'],
  // Pack size per set (13/14/15 cards), since 2026-11-13.
  ['src/lib/packsize.ts', 'packsize.ts'],
  // The card notes in the hover panel (Does, Colors, Body, Timing...), same as the site's hover (2026-11-15).
  ['src/core/facts.ts', 'facts.ts'],
];
const IMPORTS = [
  ["'../core/roles.ts'", "'./roles.ts'"],
  ["'../lib/deck.ts'", "'./deck.ts'"],
  ["'../lib/packsize.ts'", "'./packsize.ts'"],
  ["'../draft/bot.ts'", "'./bot.ts'"],
  // facts.ts sits beside stats.ts and types.ts in the trainer's core/; here those live in ../core/.
  ["'./stats.ts'", "'../core/stats.ts'"],
  ["'./types.ts'", "'../core/types.ts'"],
  // Type-only imports, erased at build: point them somewhere that exists.
  ["'./set.ts'", "'../core/types.ts'"],
  ["'../draft/engine.ts'", "'../core/types.ts'"],
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) {
  let source = readFileSync(path.join(TRAINER, from), 'utf8').replace(/\r\n/g, '\n');
  for (const [a, b] of IMPORTS) source = source.split(a).join(b);
  // '../core/stats.ts' and '../core/types.ts' already resolve to this repo's core/.
  const header = `// COPIED from draft-trainer/${from} by scripts/sync-coach.mjs. Do not edit here;\n// change the trainer and rerun the sync.\n\n`;
  writeFileSync(path.join(OUT, to), header + source);
}
console.log(`Coach synced from ${path.relative(ROOT, TRAINER) || TRAINER} into coach/ (${FILES.length} files)`);
