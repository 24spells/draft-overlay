// Sample packs for the preview from another set (e.g. TRK, 2026-11-13: "simulate what the
// overlay will show"). Packs come from the draft trainer's set file (real or generated packs),
// mapped to Arena ids through the overlay's own stats file; images from Scryfall URLs.
//   node sim/make-set-sim.mjs TRK  ->  sim-data/drafts-TRK.json, sim-data/images-TRK.json
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
const set = (process.argv[2] ?? 'TRK').toUpperCase();
const ROOT = path.resolve(import.meta.dirname, '..');
const trainer = JSON.parse(readFileSync(`~/draft-trainer/public/sets/${set}.json`, 'utf8'));
// The live stats the installed app uses; copied next to the preview so it shows the same numbers.
const live = path.join(process.env.APPDATA, 'Draft Overlay', 'card-data', `${set}.PremierDraft.json`);
const local = path.join(ROOT, 'card-data', `${set}.PremierDraft.json`);
if (existsSync(live)) copyFileSync(live, local);
const stats = JSON.parse(readFileSync(local, 'utf8'));
const idOf = new Map(Object.entries(stats.cards).map(([id, c]) => [c.name, Number(id)]));
const images = {};
for (const c of trainer.cards) if (c.image) images[c.name] = c.image;
const packs = [];
const size = trainer.packs[0].length;
for (let p = 0; p < 3; p += 1) {
  const pack = trainer.packs[p * 7].map((ix) => trainer.cards[ix].name);
  const ids = pack.map((n) => idOf.get(n) ?? idOf.get(n.split(' // ')[0])).filter((x) => x !== undefined);
  packs.push({ setCode: set, format: 'PremierDraft', draftId: null, packNumber: p + 1, pickNumber: 1, cardIds: ids, pickedCardIds: [], taken: null });
}
writeFileSync(path.join(ROOT, 'sim-data', `drafts-${set}.json`), JSON.stringify([{ date: new Date().toISOString().slice(0, 10), packs }]));
writeFileSync(path.join(ROOT, 'sim-data', `images-${set}.json`), JSON.stringify(images));
const missing = packs.flatMap((p, i) => trainer.packs[i * 7].map((ix) => trainer.cards[ix].name)).filter((n) => !idOf.has(n) && !idOf.has(n.split(' // ')[0]));
console.log(`${set}: 3 sample packs of ${size} cards, ${Object.keys(images).length} images; stats copied from the live app${missing.length ? `; no Arena id for: ${missing.join(', ')}` : ''}`);
