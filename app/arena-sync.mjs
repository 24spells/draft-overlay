// Records real Arena drafts and games and sends them to 23spells (2026-11-13:
// "log real games on 23spells"). Log reading only, like the rest of the app.
//
//  1. Archive: Arena replaces Player.log at every launch, so each log is kept as
//     arena-logs/Player-<created>.log.gz (raw data is never thrown away).
//  2. Records: core/arena-records.ts turns the log into one record per draft and
//     per game, saved as arena-records/<kind>-<id>.json (card ids plus names).
//  3. Sync: records go to the player's 23spells save with a device key. Pairing:
//     "Connect to 23spells" opens the site with the key in the #fragment; the site,
//     signed in with name + PIN, registers it. No PIN is ever stored here.
//
// Never uploaded: player names, account ids. The parser does not keep them.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readArenaLog } from './build/core/arena-records.js';

const SITE = 'https://23spells.pages.dev';
const BATCH = 20;
const SCAN_DELAY_MS = 8000;
const SYNC_EVERY_MS = 10 * 60 * 1000;
const EVENT_SET = /^[A-Za-z]+_([A-Za-z0-9]+)_\d{8}$/;

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function createArenaRecorder({ userDir, logPath, namesFor, onChange = () => {}, log = () => {} }) {
  const recDir = path.join(userDir, 'arena-records');
  const logDir = path.join(userDir, 'arena-logs');
  const statePath = path.join(userDir, 'arena-sync.json');
  let state = { token: null, name: null, synced: {}, archived: {}, scanned: [] };
  try {
    state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) };
  } catch {
    // First run.
  }
  const saveState = () => writeFileSync(statePath, JSON.stringify(state));
  let timer = null;
  let scanning = null;
  let syncing = null;
  let lastError = null;

  /** Keep a gzipped copy of a log, named by when Arena created it (stable across the rename to Player-prev.log). */
  function archive(file, text) {
    const st = statSync(file);
    const key = new Date(st.birthtimeMs || st.mtimeMs).toISOString().replace(/[:.]/g, '-');
    if (state.archived[key] === text.length) return;
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, `Player-${key}.log.gz`), gzipSync(text));
    state.archived[key] = text.length;
  }

  function setOf(rec) {
    if (rec.kind === 'draft' && rec.set) return rec.set;
    return EVENT_SET.exec(rec.event ?? '')?.[1] ?? null;
  }

  function idsOf(rec) {
    if (rec.kind === 'draft') return rec.picks.flatMap((p) => [...p.shown, p.taken ?? 0]);
    return [...rec.deck, ...rec.side, ...rec.hands.flat(), ...rec.kept, ...rec.oppSeen, ...rec.stuck,
      ...rec.turns.flatMap((t) => [...t.drew, ...(t.toHand ?? []), ...t.cast, ...t.oppCast, t.land ?? 0])];
  }

  function summaryOf(rec, set) {
    if (rec.kind === 'draft') return { set, event: rec.event, picks: rec.picks.length, wins: rec.wins, losses: rec.losses };
    return { set, event: rec.event, game: rec.game, result: rec.result, onPlay: rec.onPlay, mulligans: Math.max(0, rec.hands.length - 1), turns: rec.turns.filter((t) => t.me).length };
  }

  /** Read one log and save its records. Returns how many records changed. */
  async function scanFile(file) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return 0;
    }
    if (file.endsWith('Player.log') || file.endsWith('Player-prev.log')) archive(file, text);
    const { drafts, games, basics } = readArenaLog(text);
    mkdirSync(recDir, { recursive: true });
    let changed = 0;
    for (const rec of [...drafts, ...games]) {
      // A game with no deck or no turns is a lobby glitch, not a game.
      if (rec.kind === 'game' && (!rec.deck.length || !rec.turns.length)) continue;
      const set = setOf(rec);
      const ids = [...new Set(idsOf(rec).filter((x) => x > 0))];
      const names = {};
      const known = namesFor(set, ids);
      for (const id of ids) {
        const n = known[id] ?? basics[String(id)];
        if (n) names[id] = n;
      }
      const out = { id: rec.id, kind: rec.kind, course: rec.course, at: rec.at, summary: summaryOf(rec, set), body: { ...rec, set, names } };
      const file2 = path.join(recDir, `${rec.kind}-${rec.id}.json`);
      const text2 = JSON.stringify(out);
      let before = null;
      try {
        before = readFileSync(file2, 'utf8');
      } catch {
        // New record.
      }
      // A game read from a log that was cut short must not replace a complete one.
      if (before && rec.kind === 'game' && rec.result === null && JSON.parse(before).body?.result) continue;
      if (before === text2) continue;
      writeFileSync(file2, text2);
      changed += 1;
    }
    return changed;
  }

  async function scanAll() {
    scanning ??= (async () => {
      let changed = 0;
      // Backups made by hand (arena-logs/*.log), once each.
      if (existsSync(logDir)) {
        for (const name of readdirSync(logDir)) {
          if (!name.endsWith('.log') || state.scanned.includes(name)) continue;
          changed += await scanFile(path.join(logDir, name));
          state.scanned.push(name);
        }
      }
      changed += await scanFile(path.join(path.dirname(logPath), 'Player-prev.log'));
      changed += await scanFile(logPath);
      saveState();
      if (changed) log(`arena: ${changed} record(s) saved`);
      onChange();
      await sync();
    })().finally(() => (scanning = null));
    return scanning;
  }

  /** Re-read the log a few seconds after a draft or game ends (debounced). */
  function soon() {
    clearTimeout(timer);
    timer = setTimeout(() => void scanAll(), SCAN_DELAY_MS);
  }

  function pendingRecords() {
    if (!existsSync(recDir)) return [];
    const out = [];
    for (const name of readdirSync(recDir)) {
      if (!name.endsWith('.json')) continue;
      const text = readFileSync(path.join(recDir, name), 'utf8');
      const h = hashOf(text);
      const rec = JSON.parse(text);
      if (state.synced[rec.id] !== h) out.push({ rec, h });
    }
    return out;
  }

  async function sync() {
    if (!state.token) return;
    syncing ??= (async () => {
      const todo = pendingRecords();
      for (let i = 0; i < todo.length; i += BATCH) {
        const part = todo.slice(i, i + BATCH);
        const records = part.map(({ rec }) => ({ id: rec.id, kind: rec.kind, course: rec.course, at: rec.at, summary: JSON.stringify(rec.summary), body: JSON.stringify(rec.body) }));
        let r;
        try {
          r = await fetch(`${SITE}/api/arena/records`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-device-token': state.token },
            body: JSON.stringify({ records }),
          });
        } catch {
          lastError = 'offline';
          break;
        }
        if (r.status === 401) {
          lastError = 'not connected';
          state.name = null;
          break;
        }
        if (!r.ok) {
          lastError = `upload failed (${r.status})`;
          log(`arena: ${lastError}`);
          break;
        }
        lastError = null;
        for (const { rec, h } of part) state.synced[rec.id] = h;
        saveState();
      }
      onChange();
    })().finally(() => (syncing = null));
    return syncing;
  }

  /** Open 23spells to connect this PC, then wait for the site to confirm. */
  function connect(openExternal) {
    state.token ??= randomBytes(32).toString('hex');
    saveState();
    void openExternal(`${SITE}/#pair=${state.token}`);
    let tries = 0;
    const poll = setInterval(async () => {
      tries += 1;
      try {
        const r = await fetch(`${SITE}/api/arena/device`, { headers: { 'x-device-token': state.token } });
        if (r.ok) {
          state.name = (await r.json()).name;
          saveState();
          clearInterval(poll);
          log(`arena: connected to 23spells as ${state.name}`);
          onChange();
          await sync();
          return;
        }
      } catch {
        // Keep waiting.
      }
      if (tries >= 60) clearInterval(poll);
    }, 5000);
  }

  function disconnect() {
    state.token = null;
    state.name = null;
    state.synced = {};
    saveState();
    onChange();
  }

  function status() {
    const total = existsSync(recDir) ? readdirSync(recDir).filter((n) => n.endsWith('.json')).length : 0;
    const waiting = state.token ? pendingRecords().length : total;
    return { connected: state.name, total, waiting, error: lastError };
  }

  setInterval(() => void sync(), SYNC_EVERY_MS);
  return { scanAll, soon, sync, connect, disconnect, status };
}
