// Builds the preview's replay data from saved draft logs. Keeps only the pack
// and pick numbers, so no account details from the log reach the output.
//
//   node scripts/build-sim.ts [logsFolder]

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DraftTracker, parseLogLine } from '../core/log-parser.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOGS = process.argv[2] ?? path.join(ROOT, 'saved-drafts');

const drafts = readdirSync(LOGS)
  .filter((name) => name.startsWith('DraftLog_FRA_') && name.endsWith('.log'))
  .map((name) => {
    const tracker = new DraftTracker();
    const packs: Record<string, unknown>[] = [];
    let date = '';
    const lines = readFileSync(path.join(LOGS, name), 'utf8').split(/\r?\n/);

    for (const line of lines) {
      const event = parseLogLine(line);
      if (!event) {
        continue;
      }
      if (event.type === 'pick' && packs.length > 0) {
        packs[packs.length - 1].taken = event.cardIds[0] ?? null;
      }
      tracker.apply(event);
      if (event.type === 'pack' && tracker.view) {
        const stamp = line.match(/^<(\d{2})(\d{2})(\d{4}) /);
        date ||= stamp ? `${stamp[3]}-${stamp[2]}-${stamp[1]}` : '';
        packs.push({ ...tracker.view, draftId: null, taken: null });
      }
    }
    return { date, packs };
  })
  .filter((draft) => draft.packs.length > 0)
  .sort((a, b) => a.date.localeCompare(b.date));

mkdirSync(path.join(ROOT, 'sim-data'), { recursive: true });
writeFileSync(path.join(ROOT, 'sim-data', 'drafts.json'), JSON.stringify(drafts));
console.log(drafts.map((d) => `${d.date}: ${d.packs.length} packs`).join('\n'));

// Card pictures, for the preview only. The real overlay draws no card images.
const images: Record<string, string> = {};
let url: string | null = 'https://api.scryfall.com/cards/search?q=e%3Afra&unique=cards';
while (url) {
  const response: Response = await fetch(url, {
    headers: { 'User-Agent': 'mtg-draft-overlay/0.1', Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Scryfall: HTTP ${response.status}`);
  }
  const page: any = await response.json();
  for (const card of page.data) {
    const uri = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
    if (uri) {
      images[card.name] = uri;
      if (card.card_faces?.[0]?.name) {
        images[card.card_faces[0].name] = uri;
      }
    }
  }
  url = page.has_more ? page.next_page : null;
  await new Promise((resolve) => setTimeout(resolve, 150));
}
writeFileSync(path.join(ROOT, 'sim-data', 'images.json'), JSON.stringify(images));
console.log(`${Object.keys(images).length} card images`);
