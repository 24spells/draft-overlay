// Replays saved drafts and scores each pick against 17Lands GIH WR.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { parseLogLine } = await imp('app/build/core/log-parser.js');
const { rateSet, BASICS } = await imp('app/build/core/stats.js');

const set = JSON.parse(readFileSync(path.join(ROOT, 'card-data/FRA.PremierDraft.json'), 'utf8'));
const rows = rateSet(set, { deck: 'ALL', players: 'all', basis: 'gih', minGames: 200 });
const info = (id) => set.cards[String(id)];
const gih = (id) => {
  const c = info(id);
  return c ? rows.get(c.name)?.values.gih ?? null : null;
};
const grade = (id) => {
  const c = info(id);
  return c ? rows.get(c.name)?.grade ?? '-' : '?';
};
const name = (id) => info(id)?.name ?? `#${id}`;

const dir = path.join(ROOT, 'saved-drafts');
const all = [];
for (const file of readdirSync(dir).sort()) {
  const picks = [];
  let pack = null;
  for (const line of readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
    const e = parseLogLine(line);
    if (!e) continue;
    if (e.type === 'pack') pack = e;
    if (e.type === 'pick' && pack && e.cardIds.length) {
      picks.push({ p: pack.packNumber, k: pack.pickNumber, pack: pack.cardIds, pick: e.cardIds[0] });
      pack = null;
    }
  }
  // Final colors: two colors with most picks among the cards he took.
  const colorCount = {};
  for (const x of picks) for (const c of (info(x.pick)?.color ?? '')) colorCount[c] = (colorCount[c] ?? 0) + 1;
  const deck = Object.entries(colorCount).filter(([c]) => 'WUBRG'.includes(c)).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c).join('');
  const inColors = (id) => [...(info(id)?.color ?? '')].every((c) => deck.includes(c));

  console.log(`\n=== ${file.slice(9, 60)}  picks=${picks.length}  main colors=${deck}`);
  for (const x of picks) {
    const scored = x.pack.filter((id) => gih(id) !== null && !BASICS.has(name(id)));
    const best = scored.sort((a, b) => gih(b) - gih(a))[0];
    const bestIn = scored.filter(inColors).sort((a, b) => gih(b) - gih(a))[0];
    const mine = gih(x.pick);
    const gap = best && mine !== null ? gih(best) - mine : null;
    const gapIn = bestIn && mine !== null ? gih(bestIn) - mine : null;
    all.push({ file, p: x.p, k: x.k, gap, gapIn, mine, deck, pick: name(x.pick), best: best && name(best), bestIn: bestIn && name(bestIn) });
    const flag = gap !== null && gap >= 3 ? (gapIn !== null && gapIn >= 3 ? ' <<< MISS' : ' (off-color best)') : '';
    console.log(`P${x.p}p${x.k}  took ${name(x.pick)} [${grade(x.pick)} ${mine?.toFixed(1) ?? '-'}]  best ${best ? name(best) : '-'} [${best ? grade(best) + ' ' + gih(best).toFixed(1) : ''}]  gap ${gap?.toFixed(1) ?? '-'}  in-colors gap ${gapIn?.toFixed(1) ?? '-'}${flag}`);
  }
}

const scoredPicks = all.filter((x) => x.gap !== null);
const early = scoredPicks.filter((x) => x.k <= 4);
const avg = (a, f) => (a.reduce((s, x) => s + f(x), 0) / a.length).toFixed(2);
console.log('\n=== SUMMARY');
console.log(`scored picks: ${scoredPicks.length}`);
console.log(`took the top GIH card: ${scoredPicks.filter((x) => x.gap <= 0.5).length}`);
console.log(`within 1.5 pts of top: ${scoredPicks.filter((x) => x.gap <= 1.5).length}`);
console.log(`misses (3+ pts below best in your colors): ${scoredPicks.filter((x) => x.gapIn !== null && x.gapIn >= 3).length}`);
console.log(`avg gap to best overall: ${avg(scoredPicks, (x) => x.gap)}  | picks 1-4 of each pack: ${avg(early, (x) => x.gap)}`);
console.log(`avg gap to best in final colors: ${avg(scoredPicks.filter((x) => x.gapIn !== null), (x) => x.gapIn)}`);
