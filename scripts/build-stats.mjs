// Builds card-data/<SET>.<FORMAT>.json from 17Lands' public datasets
// (CC BY 4.0). Stores counts only; grades are worked out live from settings.
//
//   node scripts/build-stats.mjs FRA PremierDraft

import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const [set, format] = process.argv.slice(2);
if (!set || !format) {
  console.error('Usage: node scripts/build-stats.mjs SET FORMAT');
  process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname, '..');
// The app passes its own data folder; run by hand, it writes to card-data/ here.
const DATA = process.env.OVERLAY_DATA_DIR ?? path.join(ROOT, 'card-data');
const RAW = path.join(DATA, 'raw');
const BASE = 'https://17lands-public.s3.amazonaws.com/analysis_data';
const PAIRS = new Set(['WU', 'UB', 'BR', 'RG', 'WG', 'WB', 'UR', 'BG', 'WR', 'UG']);
const TOP_PLAYER_BUCKET = 0.6;
const BLOCK = 10;
const OH = 0, DR = 1, TU = 2, DK = 3;

mkdirSync(RAW, { recursive: true });

/** Downloads only if 17Lands has a newer file. Returns the file's date. */
async function download(url, file) {
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) {
    throw new Error(`${url}: HTTP ${head.status}`);
  }
  const lastModified = head.headers.get('last-modified');
  if (
    existsSync(file) &&
    lastModified &&
    statSync(file).mtimeMs >= new Date(lastModified).getTime()
  ) {
    return lastModified;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
  return lastModified;
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { fields.push(field); field = ''; }
    else field += c;
  }
  fields.push(field);
  return fields;
}

function lines(file) {
  const stream = file.endsWith('.gz')
    ? createReadStream(file).pipe(createGunzip())
    : createReadStream(file);
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

// ---------- Early data (no public files yet) ----------
// Personal use only (2026-11-11): until 17Lands publishes a set's public
// files, build the same stats file from the 17Lands website's card ratings.
// Limited by design: one all-decks, all-players group; win rates the site hides
// (under 500 games) stay hidden (wins = -1, read as no data); no color-pair or
// top-player splits. Marked source.early so the app labels it and refreshes it
// daily; the public files replace it automatically when they appear.
async function headWithRetry(url, tries = 3) {
  for (let i = 1; ; i += 1) {
    try {
      return await fetch(url, { method: 'HEAD' });
    } catch (error) {
      // Network blips (ECONNRESET) happen; try again before failing the build.
      if (i >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * i));
    }
  }
}
const publicCheck = await headWithRetry(`${BASE}/game_data/game_data_public.${set}.${format}.csv.gz`);
await publicCheck.body?.cancel();
const early = publicCheck.status === 403 || publicCheck.status === 404;
if (early) await buildEarly();

async function buildEarly() {
  const url = `https://www.17lands.com/card_ratings/data?expansion=${encodeURIComponent(set)}&format=${encodeURIComponent(format)}`;
  console.log(`No public files yet; reading early data from ${url}`);
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (personal draft overlay)' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const ratings = await response.json();
  if (!Array.isArray(ratings) || ratings.length === 0) throw new Error(`${url}: no cards`);
  const round2 = (v) => Math.round(v * 100) / 100;
  // [games, wins]; wins -1 when the site hid the rate.
  const pair = (count, rate) => (!count ? [0, 0] : [count, rate == null ? -1 : Math.round(rate * count)]);
  const names = [];
  const cards = {};
  const blocks = [];
  const picks = [];
  for (const r of ratings) {
    const n = names.length;
    names.push(r.name);
    if (r.mtga_id) {
      cards[String(r.mtga_id)] = {
        n,
        name: r.name,
        rarity: String(r.rarity ?? '').toLowerCase(),
        color: String(r.color ?? '').toUpperCase(),
        manaValue: 0,
        isLand: (r.types ?? []).some((t) => /\bLand\b/.test(t)),
      };
    }
    const block = [
      ...pair(r.opening_hand_game_count, r.opening_hand_win_rate),
      ...pair(r.drawn_game_count, r.drawn_win_rate),
      ...pair(r.ever_drawn_game_count, r.ever_drawn_win_rate),
      ...pair(r.game_count, r.win_rate),
      ...pair(r.never_drawn_game_count, r.never_drawn_win_rate),
    ];
    blocks.push(block.some((v) => v !== 0) ? block : 0);
    const ata = r.avg_pick ?? 0;
    const alsa = r.avg_seen ?? 0;
    picks.push(ata || alsa ? [round2(ata), ata ? (r.pick_count ?? 1) : 0, round2(alsa), alsa ? (r.seen_count ?? 1) : 0] : 0);
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = {
    set: set.toUpperCase(),
    format,
    source: { games: 0, drafts: 0, firstGame: null, lastGame: today, fileDate: today, early: true, url: 'https://www.17lands.com/card_data' },
    names,
    cards,
    groups: { 'ALL|all': { games: 0, wins: 0, blocks } },
    picks: { all: picks },
  };
  const target = path.join(DATA, `${set.toUpperCase()}.${format}.json`);
  writeFileSync(`${target}.tmp`, JSON.stringify(out));
  renameSync(`${target}.tmp`, target);
  const shown = ratings.filter((r) => r.ever_drawn_win_rate != null).length;
  console.log(`Wrote ${target}: EARLY data, ${names.length} cards, ${shown} with a win rate in hand`);
}

// Public files exist: the full build below. (A block, not process.exit, so open
// network handles close normally on Windows.)
if (!early) {
const gameFile = path.join(RAW, `game.${set}.${format}.csv.gz`);
const draftFile = path.join(RAW, `draft.${set}.${format}.csv.gz`);
const cardsFile = path.join(RAW, 'cards.csv');

console.log('Downloading public files if needed...');
const lastModified =
  (await download(`${BASE}/game_data/game_data_public.${set}.${format}.csv.gz`, gameFile));
await download(`${BASE}/draft_data/draft_data_public.${set}.${format}.csv.gz`, draftFile);
await download(`${BASE}/cards/cards.csv`, cardsFile);

// ---------- Game file ----------
console.log('Reading game data...');
let names = [];
let nameIndex = new Map();
let header = null;
let colKind, colCard, wonI, mainI, splashI, bucketI, timeI, firstCardCol;
const groups = new Map();
let rows = 0, badRows = 0, firstGame = null, lastGame = null;

function group(key, n) {
  let g = groups.get(key);
  if (!g) {
    g = { games: 0, wins: 0, blocks: new Int32Array(n * BLOCK) };
    groups.set(key, g);
  }
  return g;
}

for await (const line of lines(gameFile)) {
  if (!header) {
    header = parseCsvLine(line);
    const PREFIX = [['opening_hand_', OH], ['drawn_', DR], ['tutored_', TU], ['deck_', DK]];
    colKind = new Int8Array(header.length).fill(-1);
    colCard = new Int32Array(header.length).fill(-1);
    header.forEach((col, i) => {
      for (const [prefix, kind] of PREFIX) {
        if (col.startsWith(prefix)) {
          const name = col.slice(prefix.length);
          if (!nameIndex.has(name)) {
            nameIndex.set(name, names.length);
            names.push(name);
          }
          colKind[i] = kind;
          colCard[i] = nameIndex.get(name);
        }
      }
    });
    firstCardCol = colKind.findIndex((k) => k !== -1);
    wonI = header.indexOf('won');
    mainI = header.indexOf('main_colors');
    splashI = header.indexOf('splash_colors');
    bucketI = header.indexOf('user_game_win_rate_bucket');
    timeI = header.indexOf('game_time');
    var counts = [0, 1, 2, 3].map(() => new Int32Array(names.length));
    var stamp = new Int32Array(names.length).fill(-1);
    var touched = [];
    continue;
  }

  touched.length = 0;
  let start = 0, col = 0, won = 0, main = '', splash = '', bucket = '', time = '';
  const length = line.length;
  while (start <= length) {
    let end = line.indexOf(',', start);
    if (end === -1) end = length;
    if (colKind[col] === -1) {
      // Metadata columns sit on both sides of the card columns.
      if (col === wonI) won = line.slice(start, end) === 'True' ? 1 : 0;
      else if (col === mainI) main = line.slice(start, end);
      else if (col === splashI) splash = line.slice(start, end);
      else if (col === bucketI) bucket = line.slice(start, end);
      else if (col === timeI) time = line.slice(start, end);
    } else {
      const size = end - start;
      const kind = colKind[col];
      if (kind !== -1 && size > 0 && !(size === 1 && line.charCodeAt(start) === 48)) {
        const value = size === 1 ? line.charCodeAt(start) - 48 : Math.trunc(Number(line.slice(start, end)));
        if (value > 0) {
          const card = colCard[col];
          if (stamp[card] !== rows) {
            stamp[card] = rows;
            touched.push(card);
          }
          counts[kind][card] = value;
        }
      }
    }
    start = end + 1;
    col += 1;
  }

  if (col !== header.length) {
    badRows += 1;
    for (const card of touched) for (const c of counts) c[card] = 0;
    rows += 1;
    continue;
  }

  if (time) {
    if (firstGame === null || time < firstGame) firstGame = time;
    if (lastGame === null || time > lastGame) lastGame = time;
  }

  const decks = ['ALL'];
  if (PAIRS.has(main) && splash === '') decks.push(main);
  const players = ['all'];
  if (Number(bucket) >= TOP_PLAYER_BUCKET - 1e-9 && bucket !== '') players.push('top');
  const targets = [];
  for (const deck of decks) for (const who of players) targets.push(group(`${deck}|${who}`, names.length));

  for (const g of targets) { g.games += 1; g.wins += won; }

  for (const card of touched) {
    const oh = counts[OH][card], dr = counts[DR][card], tu = counts[TU][card], dk = counts[DK][card];
    const gih = oh + dr;
    const gns = Math.max(0, dk - gih - tu);
    const base = card * BLOCK;
    for (const g of targets) {
      const b = g.blocks;
      b[base] += oh; b[base + 1] += oh * won;
      b[base + 2] += dr; b[base + 3] += dr * won;
      b[base + 4] += gih; b[base + 5] += gih * won;
      b[base + 6] += dk; b[base + 7] += dk * won;
      b[base + 8] += gns; b[base + 9] += gns * won;
    }
    counts[OH][card] = counts[DR][card] = counts[TU][card] = counts[DK][card] = 0;
  }
  rows += 1;
}
console.log(`  ${rows} games, ${badRows} malformed, ${names.length} cards`);

// ---------- Draft file ----------
console.log('Reading draft data...');
const newPickTotals = () => ({
  ataSum: new Float64Array(names.length),
  ataN: new Int32Array(names.length),
  lastSum: new Float64Array(names.length),
  lastN: new Int32Array(names.length),
});
const pickTotals = { all: newPickTotals(), top: newPickTotals() };
let draftHeader = null, packCol, draftI, packI, pickI, chosenI, draftBucketI, lastUseful;
let currentDraft = null, currentTop = false, seen = new Map();
let draftCount = 0, pickRows = 0, minPick = Infinity, skippedDraftRows = 0;

function flushDraft() {
  for (const [key, last] of seen) {
    const card = key % 2048;
    pickTotals.all.lastSum[card] += last + 1;
    pickTotals.all.lastN[card] += 1;
    if (currentTop) {
      pickTotals.top.lastSum[card] += last + 1;
      pickTotals.top.lastN[card] += 1;
    }
  }
  seen = new Map();
}

for await (const line of lines(draftFile)) {
  if (!draftHeader) {
    draftHeader = parseCsvLine(line);
    packCol = new Int32Array(draftHeader.length).fill(-1);
    draftHeader.forEach((col, i) => {
      if (col.startsWith('pack_card_')) {
        const card = nameIndex.get(col.slice('pack_card_'.length));
        if (card !== undefined) packCol[i] = card;
      }
    });
    draftI = draftHeader.indexOf('draft_id');
    packI = draftHeader.indexOf('pack_number');
    pickI = draftHeader.indexOf('pick_number');
    chosenI = draftHeader.indexOf('pick');
    draftBucketI = draftHeader.indexOf('user_game_win_rate_bucket');
    lastUseful = Math.max(
      packCol.reduce((max, card, i) => (card !== -1 ? i : max), 0),
      draftBucketI, draftI, packI, pickI, chosenI,
    );
    if (names.length >= 2048) throw new Error('Too many cards for the seen key');
    continue;
  }

  let start = 0, col = 0, draft = '', pack = -1, pick = -1, chosen = '', bucket = '';
  const packCards = [];
  const length = line.length;
  while (start <= length && col <= lastUseful) {
    let end;
    if (line.charCodeAt(start) === 34) {
      let close = line.indexOf('"', start + 1);
      while (close !== -1 && line.charCodeAt(close + 1) === 34) close = line.indexOf('"', close + 2);
      end = close === -1 ? length : close + 1;
    } else {
      end = line.indexOf(',', start);
      if (end === -1) end = length;
    }
    if (col === draftI) draft = line.slice(start, end);
    else if (col === packI) pack = Number(line.slice(start, end));
    else if (col === pickI) pick = Number(line.slice(start, end));
    else if (col === chosenI) chosen = line.slice(start, end).replace(/^"|"$/g, '').replaceAll('""', '"');
    else if (col === draftBucketI) bucket = line.slice(start, end);
    else if (packCol[col] !== -1) {
      const size = end - start;
      if (size > 0 && !(size === 1 && line.charCodeAt(start) === 48)) packCards.push(packCol[col]);
    }
    start = end + 1;
    col += 1;
  }

  if (!draft || !(pack >= 0) || !(pick >= 0)) {
    skippedDraftRows += 1;
    continue;
  }

  if (draft !== currentDraft) {
    if (currentDraft !== null) flushDraft();
    currentDraft = draft;
    currentTop = bucket !== '' && Number(bucket) >= TOP_PLAYER_BUCKET - 1e-9;
    draftCount += 1;
  }

  pickRows += 1;
  minPick = Math.min(minPick, pick);

  const chosenCard = nameIndex.get(chosen);
  if (chosenCard !== undefined) {
    pickTotals.all.ataSum[chosenCard] += pick + 1;
    pickTotals.all.ataN[chosenCard] += 1;
    if (currentTop) {
      pickTotals.top.ataSum[chosenCard] += pick + 1;
      pickTotals.top.ataN[chosenCard] += 1;
    }
  }

  // A booster returns after 8 picks, so pick mod 8 identifies which booster.
  for (const card of packCards) {
    const key = (pack * 8 + (pick % 8)) * 2048 + card;
    const previous = seen.get(key);
    if (previous === undefined || pick > previous) seen.set(key, pick);
  }
}
if (currentDraft !== null) flushDraft();
console.log(`  ${draftCount} drafts, ${pickRows} picks, ${skippedDraftRows} skipped, lowest pick_number ${minPick}`);
if (minPick !== 0) throw new Error(`Expected 0-indexed pick_number, lowest was ${minPick}`);

// ---------- Card list ----------
console.log('Reading card list...');
const cards = {};
let cardHeader = null, c;
for await (const line of lines(cardsFile)) {
  if (!cardHeader) {
    cardHeader = parseCsvLine(line.replace(/^﻿/, ''));
    c = Object.fromEntries(cardHeader.map((name, i) => [name, i]));
    continue;
  }
  const row = parseCsvLine(line);
  const name = row[c.name]?.trim();
  const inSet = row[c.expansion]?.toUpperCase() === set.toUpperCase();
  const isBasic = row[c.rarity]?.toLowerCase() === 'basic';
  if (!nameIndex.has(name) && !(inSet && isBasic)) continue;
  cards[row[c.id]] = {
    n: nameIndex.get(name) ?? -1,
    name,
    rarity: row[c.rarity].toLowerCase(),
    color: row[c.color_identity].toUpperCase(),
    manaValue: Number(row[c.mana_value]) || 0,
    isLand: row[c.types].includes('Land'),
  };
}

// ---------- Output ----------
const out = {
  set: set.toUpperCase(),
  format,
  source: {
    games: rows - badRows,
    drafts: draftCount,
    firstGame,
    lastGame,
    fileDate: lastModified ? new Date(lastModified).toISOString().slice(0, 10) : null,
  },
  names,
  cards,
  groups: {},
  picks: {},
};

for (const [key, g] of groups) {
  const blocks = [];
  for (let i = 0; i < names.length; i += 1) {
    const block = Array.from(g.blocks.subarray(i * BLOCK, (i + 1) * BLOCK));
    blocks.push(block.some((v) => v !== 0) ? block : 0);
  }
  out.groups[key] = { games: g.games, wins: g.wins, blocks };
}

const round = (v) => Math.round(v * 100) / 100;
for (const [who, t] of Object.entries(pickTotals)) {
  out.picks[who] = names.map((_, i) =>
    t.ataN[i] === 0 && t.lastN[i] === 0
      ? 0
      : [t.ataN[i] ? round(t.ataSum[i] / t.ataN[i]) : 0, t.ataN[i], t.lastN[i] ? round(t.lastSum[i] / t.lastN[i]) : 0, t.lastN[i]],
  );
}

const target = path.join(DATA, `${set.toUpperCase()}.${format}.json`);
// Write then rename, so the app never reads a half-written file.
writeFileSync(`${target}.tmp`, JSON.stringify(out));
renameSync(`${target}.tmp`, target);
if (process.env.OVERLAY_DISCARD_RAW === '1') {
  rmSync(gameFile, { force: true });
  rmSync(draftFile, { force: true });
}
console.log(`Wrote ${target}: ${Object.keys(cards).length} card IDs, ${groups.size} stat groups`);
}
