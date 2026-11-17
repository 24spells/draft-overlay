// Records real Arena drafts and games and sends them to 24spells (2026-11-13:
// "log real games on 24spells"). Log reading only, like the rest of the app.
//
//  1. Archive: Arena replaces Player.log at every launch, so each log is kept as
//     arena-logs/Player-<created>.log.gz (raw data is never thrown away).
//  2. Records: core/arena-records.ts turns the log into one record per draft and
//     per game, saved as arena-records/<kind>-<id>.json (card ids plus names).
//  3. Sync: records go to the player's 24spells save with a device key. Pairing:
//     "Connect to 24spells" opens the site with the key in the #fragment; the site,
//     signed in with name + PIN, registers it. No PIN is ever stored here.
//
// Never uploaded: player names, account ids. The parser does not keep them.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readArenaLog } from './build/core/arena-records.js';
// Full action-by-action replays of each game (2026-11-15), gzipped into the game record.
import { readReplays, replayIds, REPLAY_VERSION } from './build/core/replay.js';
import { SITE } from './site.mjs';
const BATCH = 20;
const SCAN_DELAY_MS = 8000;
const SYNC_EVERY_MS = 10 * 60 * 1000;
const EVENT_SET = /^[A-Za-z]+_([A-Za-z0-9]+)_\d{8}$/;

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function createArenaRecorder({ userDir, logPath, namesFor, onChange = () => {}, log = () => {}, share = () => true }) {
  const recDir = path.join(userDir, 'arena-records');
  const logDir = path.join(userDir, 'arena-logs');
  const statePath = path.join(userDir, 'arena-sync.json');
  let state = { token: null, name: null, synced: {}, archived: {}, scanned: [], replayed: [] };
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

  /**
   * Keep a gzipped copy of a log, named by the session's first timestamp (stable across
   * the rename to Player-prev.log). Not the file's creation date: Windows gives a file
   * re-created under the same name its old creation date, so every session looked the same.
   */
  function archive(file, text) {
    if (text.length < 4096) return;
    const first = /(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?: ([AP]M))?/.exec(text.slice(0, 65536));
    const key = first
      ? `${first[3]}-${first[1].padStart(2, '0')}-${first[2].padStart(2, '0')}_${String(first[7] ? (Number(first[4]) % 12) + (first[7] === 'PM' ? 12 : 0) : Number(first[4])).padStart(2, '0')}-${first[5]}-${first[6]}`
      : `h${hashOf(text.slice(0, 4096))}`;
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
    if (rec.kind === 'draft') return [...rec.picks.flatMap((p) => [...p.shown, p.taken ?? 0]), ...(rec.deck ?? []).map(([id]) => id)];
    return [...rec.deck, ...rec.side, ...rec.hands.flat(), ...rec.kept, ...rec.oppSeen, ...rec.stuck,
      ...rec.turns.flatMap((t) => [...t.drew, ...(t.toHand ?? []), ...t.cast, ...t.oppCast, t.land ?? 0])];
  }

  function summaryOf(rec, set) {
    if (rec.kind === 'draft') return { set, event: rec.event, picks: rec.picks.length, wins: rec.wins, losses: rec.losses };
    return { set, event: rec.event, game: rec.game, result: rec.result, onPlay: rec.onPlay, mulligans: Math.max(0, rec.hands.length - 1), turns: rec.turns.filter((t) => t.me).length, rank: rec.rank ?? null, run: rec.run ?? null };
  }

  /** Read one log and save its records. Returns how many records changed. */
  async function scanFile(file) {
    let text;
    try {
      text = file.endsWith('.gz') ? gunzipSync(await readFile(file)).toString('utf8') : await readFile(file, 'utf8');
    } catch {
      return 0;
    }
    if (file.endsWith('Player.log') || file.endsWith('Player-prev.log')) archive(file, text);
    const { drafts, games, basics } = readArenaLog(text);
    const replays = readReplays(text);
    mkdirSync(recDir, { recursive: true });
    let changed = 0;
    for (const rec of [...drafts, ...games]) {
      // A game with no deck or no turns is a lobby glitch, not a game.
      if (rec.kind === 'game' && (!rec.deck.length || !rec.turns.length)) continue;
      const set = setOf(rec);
      const replay = rec.kind === 'game' ? replays.get(rec.id) : undefined;
      const ids = [...new Set([...idsOf(rec), ...(replay ? replayIds(replay) : [])].filter((x) => x > 0))];
      const names = {};
      const known = namesFor(set, ids);
      for (const id of ids) {
        const n = known[id] ?? basics[String(id)];
        if (n) names[id] = n;
      }
      // The replay rides gzipped (3-10 KB a game); rf = its frame count, so a partial copy of a game
      // (a log cut short) never replaces a fuller replay.
      const extra = replay ? { replay: gzipSync(JSON.stringify(replay)).toString('base64'), rf: replay.frames.length, rv: REPLAY_VERSION } : {};
      const out = { id: rec.id, kind: rec.kind, course: rec.course, at: rec.at, summary: summaryOf(rec, set), body: { ...rec, set, names, ...extra } };
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
      if (before && rec.kind === 'game' && (JSON.parse(before).body?.rf ?? 0) > (extra.rf ?? 0)) continue;
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
      // Replays for games played before replays existed: every saved log, once (gzipped archives too).
      if (existsSync(logDir)) {
        state.replayed ??= [];
        for (const name of readdirSync(logDir)) {
          if (!/\.log(\.gz)?$/.test(name) || state.replayed.includes(name)) continue;
          changed += await scanFile(path.join(logDir, name));
          state.replayed.push(name);
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
      // A key that the site has not confirmed yet (connected from another device, e.g. the iPad): check first.
      if (!state.name) {
        try {
          const r = await fetch(`${SITE}/api/arena/device`, { headers: { 'x-device-token': state.token } });
          if (!r.ok) {
            lastError = 'waiting for 24spells to connect';
            onChange();
            return;
          }
          state.name = (await r.json()).name;
          saveState();
          log(`arena: connected to 24spells as ${state.name}`);
        } catch {
          lastError = 'offline';
          onChange();
          return;
        }
      }
      const todo = pendingRecords();
      for (let i = 0; i < todo.length; i += BATCH) {
        const part = todo.slice(i, i + BATCH);
        const records = part.map(({ rec }) => ({ id: rec.id, kind: rec.kind, course: rec.course, at: rec.at, summary: JSON.stringify(rec.summary), body: JSON.stringify(rec.body) }));
        let r;
        try {
          r = await fetch(`${SITE}/api/arena/records`, {
            method: 'PUT',
            // x-share: the setup's "pool my games anonymously" switch (2026-11-14), stored per record by the site.
            headers: { 'content-type': 'application/json', 'x-device-token': state.token, 'x-share': share() ? '1' : '0' },
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

  /** Open 24spells to connect this PC, then wait for the site to confirm. */
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
          log(`arena: connected to 24spells as ${state.name}`);
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

  /** The newest recorded draft (or game), once it is on 24spells. Null when not connected. */
  async function latest() {
    if (!state.token) return null;
    await scanAll();
    if (!state.name || !existsSync(recDir)) return null;
    let best = null;
    for (const name of readdirSync(recDir)) {
      if (!name.endsWith('.json')) continue;
      const rec = JSON.parse(readFileSync(path.join(recDir, name), 'utf8'));
      if ((rec.at ?? 0) > (best?.at ?? -1)) best = rec;
    }
    return best ? { set: best.summary?.set ?? null, course: best.course ?? best.id, at: best.at ?? null } : null;
  }

  function status() {
    const total = existsSync(recDir) ? readdirSync(recDir).filter((n) => n.endsWith('.json')).length : 0;
    const waiting = state.token ? pendingRecords().length : total;
    return { connected: state.name, pairing: Boolean(state.token && !state.name), total, waiting, error: lastError };
  }

  setInterval(() => void sync(), SYNC_EVERY_MS);
  // Waiting to be connected: check often, so records go up soon after the link is opened.
  setInterval(() => {
    if (state.token && !state.name) void sync();
  }, 30_000);
  setTimeout(() => void sync(), 5000);
  return { scanAll, soon, sync, connect, disconnect, status, latest };
}
