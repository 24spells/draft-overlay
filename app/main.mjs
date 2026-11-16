// The real app. Sits idle in the tray until Arena opens, then follows Arena's
// log and draws stats on draft packs (and opens the 17Lands client, if that
// switch is on). Reads the log and window positions only. Never touches Arena's memory.
//
// Public release work (2026-11-14, plan: MTG AI references/overlay-public-plan.md):
//   - Card stats come from 24spells (overlay-data/), built there from 17Lands' public
//     datasets. Building locally from 17Lands' raw files (incl. the early website data)
//     is a personal setting, localBuild, off for everyone else.
//   - First-run setup window (app/setup.html): Arena found, Detailed Logs on, connect to
//     24spells, share switches, start with Windows.
//   - Updates itself from GitHub Releases (electron-updater) once a release feed is
//     configured (scripts/release.mjs); 24spells' overlay/latest.json sets a minimum version.

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  screen,
  shell,
  Tray,
} from 'electron';
import { execFile, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DraftTracker, parseLogLine } from './build/core/log-parser.js';
import { LogWatcher } from './build/core/log-watcher.js';
import { createArenaRecorder } from './arena-sync.mjs';
import { SITE } from './site.mjs';
import { readArenaLog } from './build/core/arena-records.js';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const ROOT = app.getAppPath();
const APP_DIR = path.join(ROOT, 'app');
// Installed copies keep data in the user's app folder, since the install folder is replaced on update.
// A test run (OVERLAY_USER_DATA) keeps everything in its own folder.
const USER_DIR = process.env.OVERLAY_USER_DATA ?? (app.isPackaged ? app.getPath('userData') : ROOT);
const DATA_DIR = path.join(USER_DIR, 'card-data');
const SAVED_DRAFTS = path.join(USER_DIR, 'saved-drafts');
const LOG_PATH =
  process.env.MTGA_LOG_PATH ??
  path.join(os.homedir(), 'AppData', 'LocalLow', 'Wizards Of The Coast', 'MTGA', 'Player.log');
const CLIENT_SHORTCUT = path.join(
  app.getPath('appData'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', '17Lands.com', '17Lands MTGA Client.appref-ms',
);
const ARENA_IMAGE = 'MTGA.exe';
const CLIENT_IMAGE = '17Lands MTGA Client.exe';
const ARENA_POLL_MS = 3000;
const HIDE_SHORTCUT = 'Control+Shift+H';
// Stats stay current in the background, never at draft start. Premier only.
const FORMAT = 'PremierDraft';
const DATA_BASE = 'https://17lands-public.s3.amazonaws.com/analysis_data';
const REFRESH_FIRST_MS = 20 * 1000;
const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;
const HOSTED_CHECK_MS = 15 * 60 * 1000;
const NEW_SET_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // ignore old sets' files
const NEW_SET_MIN_CARDS = 150; // booster cards, to skip token and bonus sheets
const NEW_SET_LOOKBACK = 4; // newest sets in 17Lands' card list to watch
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'overlay', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let overlay = null;
let tray = null;
let arenaRunning = false;
let paused = false;
let foreground = null;
let helper = null;
let watcher = null;
let tracker = new DraftTracker();
let view = null;
let viewDirty = false;
let live = false;
let saveFile = null;
/** Real drafts and games, recorded and sent to 24spells (see arena-sync.mjs). */
let arena = null;
// A draft or game just ended: re-read the log for records.
// ClaimPrize / Complete (0.3.7): Arena marks a run finished only after its last game, often minutes later,
// so a re-read then records the finish (24spells trophies need it).
const RECORD_MARKERS = ['GameStage_GameOver', 'MatchGameRoomStateType_MatchCompleted', 'DraftCompleteDraft', 'EventSetDeck', '"CurrentModule":"ClaimPrize"', '"CurrentModule":"Complete"'];
let statusText = 'Waiting for Arena';
const statsCache = new Map();
/** When each set with no stats was last tried (0.3.7: retried every few minutes, not once a session). */
const dataChecked = new Map();
const DATA_RETRY_MS = 3 * 60 * 1000;
let refreshing = false;
let refreshPending = false;
let lastPackAt = 0;
// The view clears after every pick, so "drafting" means a pack in the last 5 minutes.
const DRAFT_QUIET_MS = 5 * 60 * 1000;
const drafting = () => Date.now() - lastPackAt < DRAFT_QUIET_MS;

if (process.env.OVERLAY_USER_DATA) app.setPath('userData', process.env.OVERLAY_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'app-settings.json');

const SETTINGS_DEFAULTS = {
  startWithWindows: true,
  /** The first-run setup window has been finished (or skipped). */
  setupDone: false,
  /** Pool this player's games anonymously for card stats (sent as x-share; on by default, one switch off). */
  share: true,
  /** Open the 17Lands client when Arena opens (optional; off by default). */
  open17Lands: false,
  /** Personal: build stats locally from 17Lands' raw files, incl. early website data. Never for others. */
  localBuild: false,
};

function readSettings() {
  try {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(next));
  } catch {
    // Settings are a convenience; never crash over them.
  }
  return next;
}

function applyStartWithWindows(enabled) {
  // Only the installed app registers with Windows: a development or test run (separate profile) never does.
  if (!app.isPackaged || process.env.OVERLAY_USER_DATA) {
    writeSettings({ startWithWindows: enabled });
    return;
  }
  // Our own entry name: Electron's default ("electron.app.Electron") is shared by every Electron app.
  const OLD_NAME = 'electron.app.Electron';
  try {
    if (app.getLoginItemSettings({ path: process.execPath, args: [], name: OLD_NAME }).openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: [], name: OLD_NAME });
    }
  } catch {
    // Older entry left as is.
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: [],
    name: 'Draft Overlay',
  });
  writeSettings({ startWithWindows: enabled });
}

// ---------- Tray ----------
function trayIcon() {
  // The 24spells mark; Electron picks tray@1.5x / tray@2x on scaled displays (scripts/make-icons.mjs).
  return nativeImage.createFromPath(path.join(APP_DIR, 'icons', 'tray.png'));
}

function refreshTray() {
  if (!tray) {
    return;
  }
  tray.setToolTip(`Draft Overlay: ${statusText}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Draft Overlay ${app.getVersion()}: ${statusText}`, enabled: false },
      ...updateMenu(),
      { type: 'separator' },
      {
        label: 'Pause overlay',
        type: 'checkbox',
        checked: paused,
        click: (item) => {
          paused = item.checked;
          updateVisibility();
        },
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: readSettings().startWithWindows,
        click: (item) => applyStartWithWindows(item.checked),
      },
      { label: 'Setup and settings...', click: () => openSetup() },
      // The full guide (what you see, settings, troubleshooting) lives on the site, one click away.
      { label: 'How to use it...', click: () => void shell.openExternal(`${SITE}/#overlay`) },
      { type: 'separator' },
      ...arenaMenu(),
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function arenaMenu() {
  if (!arena) return [];
  const s = arena.status();
  const games = `${s.total} draft and game record${s.total === 1 ? '' : 's'} on this PC`;
  if (!s.connected) {
    return [
      { label: `24spells: not connected (${games})`, enabled: false },
      { label: 'Connect to 24spells...', click: () => arena.connect((url) => shell.openExternal(url)) },
      { label: 'Build my sealed pool in 24spells', click: () => void openSealedPool() },
    ];
  }
  return [
    { label: `24spells: ${s.connected}${s.waiting ? `, ${s.waiting} to send` : ', all sent'}${s.error ? ` (${s.error})` : ''}`, enabled: false },
    { label: 'Open my Arena games', click: () => void shell.openExternal(`${SITE}/#arena`) },
    { label: 'Build my sealed pool in 24spells', click: () => void openSealedPool() },
    { label: 'Send now', click: () => void arena.scanAll() },
    { label: 'Disconnect from 24spells', click: () => arena.disconnect() },
  ];
}

// Card names for records: the set's stats file, then 17Lands' full card list.
let cardList = null;
function namesFor(setCode, ids) {
  const out = {};
  const stats = setCode ? loadStats(setCode, FORMAT) : null;
  for (const id of ids) {
    const name = stats?.cards[String(id)]?.name;
    if (name) out[id] = name;
  }
  if (ids.some((id) => !out[id])) {
    if (!cardList) {
      cardList = new Map();
      try {
        for (const line of readFileSync(path.join(DATA_DIR, 'raw', 'cards.csv'), 'utf8').split(/\r?\n/).slice(1)) {
          const m = /^(\d+),[^,]*,("(?:[^"]|"")*"|[^,]*)/.exec(line);
          if (m) cardList.set(Number(m[1]), m[2].replace(/^"|"$/g, '').replace(/""/g, '"'));
        }
      } catch {
        // No card list yet: names fill in from the stats files.
      }
    }
    for (const id of ids) if (!out[id] && cardList.has(id)) out[id] = cardList.get(id);
  }
  return out;
}

function setStatus(text) {
  statusText = text;
  refreshTray();
}

// ---------- Overlay window ----------
function createOverlay() {
  const window = new BrowserWindow({
    width: 1,
    height: 1,
    transparent: true,
    frame: false,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    fullscreenable: false,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setIgnoreMouseEvents(true, { forward: true });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('did-finish-load', () => {
    // isLoading() can still be true here, so send directly.
    window.webContents.send('overlay:view', view);
    updateVisibility();
  });
  void window.loadURL('overlay://app/index.html');
  return window;
}

function sendView() {
  if (overlay && !overlay.isDestroyed() && !overlay.webContents.isLoading()) {
    overlay.webContents.send('overlay:view', view);
  }
}

// ---------- Visibility log ----------
// A short record of what was in front and when we hid, for chasing glitches.
const VISIBILITY_LOG_MAX = 512 * 1024;
let lastShown = null;

function logVisibility(text) {
  try {
    const file = path.join(app.getPath('userData'), 'visibility.log');
    if (existsSync(file) && statSync(file).size > VISIBILITY_LOG_MAX) {
      writeFileSync(file, '');
    }
    appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // Logging must never break the overlay.
  }
}

function updateVisibility() {
  if (!overlay || overlay.isDestroyed()) {
    return;
  }
  const shouldShow = Boolean(!paused && foreground);
  if (shouldShow !== lastShown) {
    lastShown = shouldShow;
    logVisibility(shouldShow ? 'shown' : `hidden (paused=${paused}, arena in front=${Boolean(foreground)})`);
  }
  // Shown whenever Arena is in front. Outside a draft only the small tab shows.
  if (paused || !foreground) {
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.setFocusable(false);
    overlay.hide();
    return;
  }
  const bounds = screen.screenToDipRect(null, foreground);
  const current = overlay.getBounds();
  if (
    current.x !== bounds.x || current.y !== bounds.y ||
    current.width !== bounds.width || current.height !== bounds.height
  ) {
    overlay.setBounds(bounds, false);
  }
  overlay.showInactive();
}

// ---------- Which window is in front ----------
function startForegroundHelper() {
  if (helper) {
    return;
  }
  helper = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(APP_DIR, 'foreground.ps1'), String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const child = helper;
  readline.createInterface({ input: child.stdout }).on('line', handleForegroundLine);
  child.on('exit', (code) => {
    logVisibility(`window watcher exited (code ${code})`);
    if (helper === child) {
      helper = null;
      if (arenaRunning) {
        // Keep the last known state while the watcher restarts, instead of
        // blinking out for two seconds.
        setTimeout(startForegroundHelper, 1000);
      } else {
        foreground = null;
        updateVisibility();
      }
    }
  });
}

function stopForegroundHelper() {
  const child = helper;
  helper = null;
  child?.kill();
}

// Windows reports blips during focus changes: no window at all for a moment,
// or the taskbar. Hide only when something else stays in front.
const HIDE_GRACE_MS = 600;
const NONE_GRACE_MS = 1500;
let hideTimer = null;

function scheduleHide(delay, reason) {
  if (hideTimer) {
    return;
  }
  hideTimer = setTimeout(() => {
    hideTimer = null;
    logVisibility(`hide after ${delay}ms: ${reason}`);
    foreground = null;
    updateVisibility();
  }, delay);
}

function handleForegroundLine(line) {
  const [name, pid, x, y, width, height] = line.split('|');
  logVisibility(`front: ${line}`);
  if (name.toLowerCase() === 'mtga' && Number(width) > 0 && Number(height) > 0) {
    clearTimeout(hideTimer);
    hideTimer = null;
    foreground = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
    updateVisibility();
    return;
  }
  if (Number(pid) === process.pid || name.toLowerCase() === 'electron') {
    // Clicking our own panel takes focus for a moment. That should not hide us.
    return;
  }
  scheduleHide(name === 'none' ? NONE_GRACE_MS : HIDE_GRACE_MS, name);
}

// ---------- Following the log ----------
function saveLine(line, event) {
  if (!live || (event.type !== 'pack' && event.type !== 'pick')) {
    return;
  }
  if (event.type === 'pack' && (!saveFile || (event.packNumber === 1 && event.pickNumber === 1))) {
    mkdirSync(SAVED_DRAFTS, { recursive: true });
    const name = `DraftLog_${tracker.view?.format ?? 'Draft'}_${tracker.view?.setCode ?? 'unknown'}_${Date.now()}.log`;
    saveFile = path.join(SAVED_DRAFTS, name);
  }
  if (saveFile) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${pad(now.getDate())}${pad(now.getMonth() + 1)}${now.getFullYear()} ${now.toTimeString().slice(0, 8)}`;
    appendFileSync(saveFile, `<${stamp}>,${line}\n`);
  }
}

function handleLogLine(line) {
  if (line.includes('DETAILED LOGS: DISABLED')) {
    setStatus('Turn on Detailed Logs in Arena settings');
  }
  watchForRecords(line);
  const event = parseLogLine(line);
  if (!event) {
    return;
  }
  if (tracker.apply(event)) {
    viewDirty = true;
  }
  saveLine(line, event);
}

function watchForRecords(line) {
  if (arena && RECORD_MARKERS.some((m) => line.includes(m))) arena.soon();
  if (arena && line.includes('GameStage_GameOver')) setTimeout(nudgeToConnect, 30_000);
}

/** 0.3.7: games are kept on this PC but go nowhere until it is connected. Say so after a game, once a day. */
const NUDGE_EVERY_MS = 20 * 60 * 60 * 1000;
function nudgeToConnect() {
  const s = arena?.status();
  if (!s || s.connected || !Notification.isSupported()) return;
  const last = readSettings().connectNudgeAt ?? 0;
  if (Date.now() - last < NUDGE_EVERY_MS) return;
  writeSettings({ connectNudgeAt: Date.now() });
  const note = new Notification({
    title: 'Your games are not on 24spells yet',
    body: s.pairing
      ? 'Finish connecting: sign in on 24spells in the browser tab that opened. Click to open it again.'
      : 'Your results, replays and trophies show up on 24spells once this PC is connected. Click to connect.',
  });
  note.on('click', () => arena.connect((url) => shell.openExternal(url)));
  note.show();
  logData('arena: reminded to connect to 24spells');
}

function flushView() {
  live = true;
  if (!viewDirty) {
    return;
  }
  viewDirty = false;
  view = tracker.view;
  if (view) {
    lastPackAt = Date.now();
    void ensureData(view.setCode);
  }
  sendView();
  updateVisibility();
}

function resetLogState() {
  tracker = new DraftTracker();
  viewDirty = true;
  saveFile = null;
}

function startWatching() {
  live = false;
  resetLogState();
  watcher = new LogWatcher(LOG_PATH, {
    onLine: handleLogLine,
    onBatch: flushView,
    onReset: resetLogState,
    onError: (error) => console.error('[log]', error),
  });
  watcher.start();
}

function stopWatching() {
  watcher?.stop();
  watcher = null;
  view = null;
  viewDirty = false;
  sendView();
  updateVisibility();
}

// ---------- 17Lands stats files ----------
function loadStats(setCode, format) {
  const file = path.join(DATA_DIR, `${setCode}.${format}.json`);
  if (statsCache.has(file)) {
    return statsCache.get(file);
  }
  if (!existsSync(file)) {
    return null;
  }
  const stats = JSON.parse(readFileSync(file, 'utf8'));
  statsCache.set(file, stats);
  return stats;
}

function inferSet(cardIds) {
  if (!existsSync(DATA_DIR)) {
    return null;
  }
  const files = readdirSync(DATA_DIR).filter((name) => name.endsWith('.PremierDraft.json'));
  for (const name of files) {
    const setCode = name.split('.')[0];
    const stats = loadStats(setCode, 'PremierDraft');
    if (cardIds.filter((id) => stats.cards[String(id)]).length > cardIds.length / 2) {
      return setCode;
    }
  }
  return null;
}

function logData(text) {
  try {
    appendFileSync(path.join(app.getPath('userData'), 'data.log'), `${new Date().toISOString()}  ${text}\n`);
  } catch {
    // Logging must never break the app.
  }
}

/** Crunches a set's files in a separate, low-priority process so nothing else slows down. */
function runBuild(setCode) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', 'build-stats.mjs'), setCode, FORMAT],
      {
        cwd: ROOT,
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          OVERLAY_DATA_DIR: DATA_DIR,
          // Installed copies drop the ~100MB raw downloads once the small stats file is built.
          ...(app.isPackaged ? { OVERLAY_DISCARD_RAW: '1' } : {}),
        },
      },
      (error) => {
        logData(`build ${setCode} ${error ? `failed: ${error.message.split('\n')[0]}` : 'done'} in ${Math.round((Date.now() - started) / 1000)}s`);
        resolve(!error);
      },
    );
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // Runs at normal priority if Windows refuses.
    }
  });
}

/** When 17Lands last published a set's Premier game file, or null if none yet. */
async function publishedDate(setCode) {
  try {
    const url = `${DATA_BASE}/game_data/game_data_public.${setCode}.${FORMAT}.csv.gz`;
    const response = await fetch(url, { method: 'HEAD' });
    const date = response.ok ? response.headers.get('last-modified') : null;
    return date ? new Date(date).getTime() : null;
  } catch {
    return null;
  }
}

/** The newest real sets in 17Lands' card list. New sets are added at the end. */
async function newestSets() {
  try {
    const response = await fetch(`${DATA_BASE}/cards/cards.csv`);
    if (!response.ok) {
      return [];
    }
    const counts = new Map();
    for (const line of (await response.text()).split(/\r?\n/).slice(1)) {
      if (line.endsWith(',True')) {
        const expansion = line.split(',')[1];
        counts.set(expansion, (counts.get(expansion) ?? 0) + 1);
      }
    }
    return [...counts]
      .filter(([, count]) => count >= NEW_SET_MIN_CARDS)
      .map(([expansion]) => expansion)
      .slice(-NEW_SET_LOOKBACK);
  } catch {
    return [];
  }
}

function localSets() {
  mkdirSync(DATA_DIR, { recursive: true });
  return readdirSync(DATA_DIR)
    .filter((name) => name.endsWith(`.${FORMAT}.json`))
    .map((name) => name.split('.')[0]);
}

/** Built from the 17Lands website because the public files were not out yet. */
function isEarly(setCode) {
  try {
    return loadStats(setCode, FORMAT)?.source?.early === true;
  } catch {
    return false;
  }
}
const EARLY_REFRESH_MS = 20 * 60 * 60 * 1000;

function builtAt(setCode) {
  const file = path.join(DATA_DIR, `${setCode}.${FORMAT}.json`);
  return existsSync(file) ? statSync(file).mtimeMs : null;
}

/**
 * Keeps stats current between drafts: rebuilds a set we have when 17Lands
 * publishes a newer file, and builds a new set the day its file appears.
 * Waits if a draft is open, so grades never change between picks.
 */
async function refreshInBackground(reason) {
  if (!readSettings().localBuild) {
    return refreshHosted(reason);
  }
  if (refreshing) {
    return;
  }
  if (drafting()) {
    if (!refreshPending) {
      refreshPending = true;
      setTimeout(() => {
        refreshPending = false;
        void refreshInBackground(`${reason}, after draft`);
      }, DRAFT_QUIET_MS);
    }
    return;
  }
  refreshing = true;
  refreshPending = false;
  try {
    const have = localSets();
    const candidates = [...new Set([...have, ...(await newestSets())])];
    logData(`check (${reason}): ${candidates.join(', ')}`);
    let changed = false;
    for (const setCode of candidates) {
      const published = await publishedDate(setCode);
      const built = builtAt(setCode);
      const isNew = built === null;
      const early = !isNew && isEarly(setCode);
      if (!published) {
        // No public file yet: keep early website data fresh, once a day.
        if (early && Date.now() - built > EARLY_REFRESH_MS) {
          setStatus(`Updating ${setCode} early stats`);
          changed = (await runBuild(setCode)) || changed;
        }
        continue;
      }
      if (isNew && Date.now() - published > NEW_SET_MAX_AGE_MS) {
        continue;
      }
      // The public file replaces early data the first time it appears.
      if (isNew || early || built < published) {
        setStatus(`Updating ${setCode} stats`);
        changed = (await runBuild(setCode)) || changed;
      }
    }
    if (changed) {
      statsCache.clear();
    }
  } finally {
    refreshing = false;
    setStatus(arenaRunning ? 'Running' : 'Waiting for Arena');
  }
}

/** Last resort for a set the background check never saw: build it now, still off the main thread. */
async function ensureData(setCode) {
  if (!setCode || builtAt(setCode) !== null || Date.now() - (dataChecked.get(setCode) ?? 0) < DATA_RETRY_MS) {
    return;
  }
  dataChecked.set(setCode, Date.now());
  setStatus(`Updating ${setCode} stats`);
  const ok = readSettings().localBuild ? await runBuild(setCode) : await downloadHostedSet(setCode);
  statsCache.clear();
  setStatus(ok ? 'Running' : `No public data yet for ${setCode}`);
  sendView();
}

ipcMain.handle('overlay:stats', (_event, setCode, format, cardIds) => {
  const resolved = setCode ?? inferSet(cardIds);
  if (!resolved) {
    return null;
  }
  const exact = loadStats(resolved, format);
  if (exact) {
    return { stats: exact, note: null };
  }
  const premier = format === 'PremierDraft' ? null : loadStats(resolved, 'PremierDraft');
  return premier
    ? { stats: premier, note: 'Showing Premier Draft stats. 17Lands has no public file for this format and set.' }
    : null;
});

// ---------- The web trainer's coach files (24spells) ----------
// The coach hint runs the trainer's engine on the trainer's own set files, so
// the overlay and the site agree. Cached on disk; refreshed at most daily, in
// the background, so a draft never waits on the network once a set is cached.
const COACH_SITE = `${SITE}/sets`;
const COACH_DIR = path.join(USER_DIR, 'coach-data');
const COACH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const coachCache = new Map();
const coachFetching = new Map();

/** One JSON file from the site, or null (missing files come back as the site's HTML page). */
async function fetchCoachFile(name) {
  try {
    const response = await fetch(`${COACH_SITE}/${name}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function downloadCoach(setCode) {
  const [set, flow, builds, splash] = await Promise.all(
    [`${setCode}.json`, `${setCode}-flow.json`, `${setCode}-builds.json`, `${setCode}-splash.json`].map(fetchCoachFile),
  );
  if (!set?.cards || !set?.stats) {
    logData(`coach ${setCode}: not on the trainer site (or offline)`);
    return null;
  }
  const data = { set, flow, builds, splash };
  mkdirSync(COACH_DIR, { recursive: true });
  writeFileSync(path.join(COACH_DIR, `${setCode}.json`), JSON.stringify({ fetched: Date.now(), ...data }));
  coachCache.set(setCode, data);
  logData(`coach ${setCode}: downloaded (${set.cards.length} cards, flow ${flow ? 'yes' : 'no'}, shape prices ${builds?.shapeTax ? 'yes' : 'no'}, splash data ${splash ? 'yes' : 'no'})`);
  return data;
}

function refreshCoach(setCode) {
  if (!coachFetching.has(setCode)) {
    coachFetching.set(setCode, downloadCoach(setCode).finally(() => coachFetching.delete(setCode)));
  }
  return coachFetching.get(setCode);
}

ipcMain.handle('overlay:coach', async (_event, setCode) => {
  if (!/^[A-Z0-9]{2,5}$/.test(String(setCode ?? ''))) {
    return null;
  }
  if (coachCache.has(setCode)) {
    return coachCache.get(setCode);
  }
  const file = path.join(COACH_DIR, `${setCode}.json`);
  if (existsSync(file)) {
    try {
      const { fetched, ...data } = JSON.parse(readFileSync(file, 'utf8'));
      coachCache.set(setCode, data);
      if (Date.now() - fetched > COACH_MAX_AGE_MS) {
        void refreshCoach(setCode);
      }
      return data;
    } catch {
      // A broken cache file: download again below.
    }
  }
  return refreshCoach(setCode);
});

ipcMain.on('overlay:interactive', (event, interactive) => {
  if (!overlay || overlay.isDestroyed() || event.sender !== overlay.webContents) {
    return;
  }
  overlay.setIgnoreMouseEvents(!interactive, { forward: true });
  // Dropdowns need a focusable window. Give it back as soon as the mouse leaves.
  overlay.setFocusable(Boolean(interactive));
});

// ---------- Noticing Arena open and close ----------
function isRunning(image) {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true },
      (error, stdout) => resolve(!error && stdout.toLowerCase().includes(image.toLowerCase())),
    );
  });
}

async function startClientIfNeeded() {
  if (!readSettings().open17Lands || !existsSync(CLIENT_SHORTCUT) || (await isRunning(CLIENT_IMAGE))) {
    return;
  }
  spawn('cmd.exe', ['/c', 'start', '', CLIENT_SHORTCUT], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

function arenaOpened() {
  arenaRunning = true;
  clearTimeout(autoInstallTimer);
  setStatus('Running');
  void refreshInBackground('Arena opened');
  void startClientIfNeeded();
  startForegroundHelper();
  startWatching();
  globalShortcut.register(HIDE_SHORTCUT, () => {
    overlay?.webContents.send('overlay:toggle-hidden');
  });
}

function arenaClosed() {
  arenaRunning = false;
  setStatus('Waiting for Arena');
  globalShortcut.unregister(HIDE_SHORTCUT);
  stopForegroundHelper();
  stopWatching();
  foreground = null;
  updateVisibility();
  arena?.soon();
  maybeAutoInstall();
}

async function pollArena() {
  const running = await isRunning(ARENA_IMAGE);
  if (running && !arenaRunning) {
    arenaOpened();
  } else if (!running && arenaRunning) {
    arenaClosed();
  }
}

/** Developer check: pretends Arena is in front and saves what gets drawn. */
function runSmokeTest(shotPath) {
  overlay = createOverlay();
  overlay.webContents.on('console-message', (event) => console.log('[renderer]', event.message));
  overlay.webContents.on('did-fail-load', (_event, code, description) => console.log('[load failed]', code, description));
  arenaRunning = true;
  foreground = { x: 100, y: 100, width: 1600, height: 900 };
  startWatching();
  setTimeout(async () => {
    const image = await overlay.webContents.capturePage();
    writeFileSync(shotPath, image.toPNG());
    const page = await overlay.webContents.executeJavaScript(`({
      bridge: typeof window.draftOverlay,
      overlayChildren: document.getElementById('overlay')?.children.length,
      plates: document.querySelectorAll('.plate').length,
      firstPlate: document.querySelector('.plate')?.innerText,
      plateRect: JSON.stringify(document.querySelector('.plate')?.getBoundingClientRect()),
      controlsShown: document.querySelector('.controls')?.classList.contains('shown'),
      credit: document.querySelector('.credit')?.textContent,
      status: document.querySelector('.status')?.textContent,
      size: innerWidth + 'x' + innerHeight,
    })`);
    console.log('[page]', JSON.stringify(page));
    console.log('[image]', JSON.stringify(image.getSize()));
    console.log('[smoke]', JSON.stringify({
      pack: view ? `P${view.packNumber}P${view.pickNumber}` : null,
      set: view?.setCode ?? null,
      cards: view?.cardIds.length ?? 0,
      picks: view?.pickedCardIds.length ?? 0,
      bounds: overlay.getBounds(),
      visible: overlay.isVisible(),
    }));
    app.quit();
  }, 5000);
}

// ---------- Card stats from 24spells ----------
// The site hosts each set's stats file (built from 17Lands' public datasets, CC BY 4.0, credited on
// screen) plus index.json. Installed copies download the newest sets in the background and any other
// set the first time it is drafted: small files, seconds, nothing crunched on the player's PC.
const HOSTED = `${SITE}/overlay-data`;
const HOSTED_NEWEST = 4;
let hostedIndex = null;

async function fetchHostedIndex() {
  try {
    const r = await fetch(`${HOSTED}/index.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    hostedIndex = await r.json();
    return hostedIndex;
  } catch {
    return null;
  }
}

function localFileDate(setCode, format) {
  try {
    return loadStats(setCode, format)?.source?.fileDate ?? null;
  } catch {
    return null;
  }
}

/** Download one set's files (every format the site has) when newer than ours. True if usable after. */
async function downloadHostedSet(setCode, index = hostedIndex) {
  const idx = index ?? (await fetchHostedIndex());
  const formats = idx?.sets?.[setCode];
  if (!formats) {
    logData(`hosted ${setCode}: not on 24spells yet`);
    return builtAt(setCode) !== null;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  let got = 0;
  for (const [format, meta] of Object.entries(formats)) {
    const have = localFileDate(setCode, format);
    if (have && meta.fileDate && have >= meta.fileDate) continue;
    try {
      const r = await fetch(`${HOSTED}/${setCode}.${format}.json`, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) continue;
      const text = await r.text();
      JSON.parse(text);
      const file = path.join(DATA_DIR, `${setCode}.${format}.json`);
      writeFileSync(file, text);
      statsCache.delete(file);
      got += 1;
    } catch (error) {
      logData(`hosted ${setCode} ${format}: ${error.message}`);
    }
  }
  if (got) logData(`hosted ${setCode}: ${got} file(s) updated`);
  return builtAt(setCode) !== null;
}

async function refreshHosted(reason) {
  if (refreshing) return;
  if (drafting()) {
    if (!refreshPending) {
      refreshPending = true;
      setTimeout(() => {
        refreshPending = false;
        void refreshInBackground(`${reason}, after draft`);
      }, DRAFT_QUIET_MS);
    }
    return;
  }
  refreshing = true;
  try {
    const idx = await fetchHostedIndex();
    if (!idx) {
      logData(`hosted check (${reason}): 24spells unreachable`);
      return;
    }
    const newest = (idx.order ?? Object.keys(idx.sets)).slice(0, HOSTED_NEWEST);
    const sets = [...new Set([...localSets(), ...newest])].filter((c) => idx.sets[c]);
    logData(`hosted check (${reason}): ${sets.join(', ')}`);
    for (const setCode of sets) await downloadHostedSet(setCode, idx);
  } finally {
    refreshing = false;
    setStatus(arenaRunning ? 'Running' : 'Waiting for Arena');
  }
}

// ---------- First-run setup (and Setup and settings...) ----------
let setupWindow = null;

/** Detailed Logs: true when Arena says so (or detailed lines show up), false when it says off, null if unknown. */
function detailedLogs() {
  let text = '';
  try {
    text = readFileSync(LOG_PATH, 'utf8');
  } catch {
    return null;
  }
  if (text.includes('DETAILED LOGS: DISABLED')) return false;
  if (text.includes('DETAILED LOGS: ENABLED') || text.includes('[UnityCrossThreadLogger]==>')) return true;
  return null;
}

function setupState() {
  const settings = readSettings();
  const s = arena?.status() ?? {};
  return {
    version: app.getVersion(),
    arenaInstalled: existsSync(path.dirname(LOG_PATH)),
    arenaLog: existsSync(LOG_PATH),
    arenaRunning,
    detailedLogs: detailedLogs(),
    connected: s.connected ?? null,
    connecting: Boolean(s.pairing),
    client17: existsSync(CLIENT_SHORTCUT),
    share: settings.share,
    open17Lands: settings.open17Lands,
    startWithWindows: settings.startWithWindows,
    setupDone: settings.setupDone,
  };
}

function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return setupWindow;
  }
  setupWindow = new BrowserWindow({
    width: 620,
    height: 780,
    title: 'Draft Overlay setup',
    icon: path.join(APP_DIR, 'icons', 'tray@2x.png'),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'setup-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  setupWindow.once('ready-to-show', () => setupWindow?.show());
  setupWindow.on('closed', () => {
    setupWindow = null;
  });
  void setupWindow.loadURL('overlay://app/setup.html');
  return setupWindow;
}

const fromSetup = (event) => setupWindow && !setupWindow.isDestroyed() && event.sender === setupWindow.webContents;
ipcMain.handle('setup:state', (event) => (fromSetup(event) ? setupState() : null));
ipcMain.handle('setup:set', (event, key, value) => {
  if (!fromSetup(event) || !['share', 'open17Lands', 'startWithWindows'].includes(key)) return null;
  if (key === 'startWithWindows') applyStartWithWindows(Boolean(value));
  else writeSettings({ [key]: Boolean(value) });
  if (key === 'open17Lands' && value && arenaRunning) void startClientIfNeeded();
  refreshTray();
  return setupState();
});
ipcMain.handle('setup:connect', (event) => {
  if (!fromSetup(event) || !arena) return null;
  arena.connect((url) => shell.openExternal(url));
  return setupState();
});
ipcMain.handle('setup:done', (event) => {
  if (!fromSetup(event)) return null;
  writeSettings({ setupDone: true });
  setupWindow?.close();
  return true;
});
ipcMain.handle('setup:open', (event, which) => {
  if (!fromSetup(event)) return false;
  const links = {
    arenaLogs: 'https://mtgarena-support.wizards.com/hc/en-us/articles/360000726823-Creating-Log-Files-on-PC-Mac-Steam',
    seventeen: 'https://www.17lands.com',
    privacy: `${SITE}/#privacy`,
    site: SITE,
  };
  if (!links[which]) return false;
  void shell.openExternal(links[which]);
  return true;
});

// ---------- Updates ----------
// App updates: electron-updater reads the release feed baked in at build time (app-update.yml, from
// scripts/release.mjs). A build without one (npm run dist) simply never checks. Downloads in the
// background; installs when the app quits, now from the tray, or on its own once Arena has been
// closed for a few minutes (2026-11-15: an overlay left running for days never installed 0.3.3 or
// 0.3.4, so its games had no replays).
let updateReady = null;
const AUTO_INSTALL_AFTER_MS = 3 * 60 * 1000;
let autoInstallTimer = null;
/** An update is waiting and Arena is closed: install it after a quiet spell (uploads finish first). */
function maybeAutoInstall() {
  clearTimeout(autoInstallTimer);
  if (!updateReady || arenaRunning) return;
  autoInstallTimer = setTimeout(async () => {
    if (!updateReady || arenaRunning || drafting() || (await isRunning(ARENA_IMAGE))) return;
    logData(`update: installing ${updateReady} on its own (Arena closed)`);
    installUpdate();
  }, AUTO_INSTALL_AFTER_MS);
}
let needsUpdate = null;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

function updateMenu() {
  const items = [];
  if (updateReady) items.push({ label: `Restart to update to ${updateReady}`, click: () => installUpdate() });
  if (needsUpdate) items.push({ label: `Update needed: get version ${needsUpdate}`, click: () => void shell.openExternal(`${SITE}/#overlay`) });
  return items;
}

let updater = null;
function installUpdate() {
  try {
    updater?.quitAndInstall(true, true);
  } catch (error) {
    logData(`update: install failed: ${error.message}`);
  }
}

function startUpdater() {
  if (!app.isPackaged || !existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    logData('update: no release feed in this build; not checking');
    return;
  }
  try {
    const require = createRequire(import.meta.url);
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (error) {
    logData(`update: unavailable (${error.message})`);
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('error', (error) => logData(`update: ${error?.message ?? error}`));
  updater.on('update-available', (info) => logData(`update: ${info.version} available, downloading`));
  updater.on('update-downloaded', (info) => {
    updateReady = info.version;
    logData(`update: ${info.version} ready`);
    refreshTray();
    if (Notification.isSupported()) {
      const note = new Notification({ title: 'Draft Overlay update ready', body: `Version ${info.version} installs on its own while Arena is closed. Click to restart now.` });
      note.on('click', () => installUpdate());
      note.show();
    }
    maybeAutoInstall();
  });
  const check = () => {
    if (drafting()) return; // never mid-draft
    updater.checkForUpdates().catch((error) => logData(`update: check failed: ${error?.message ?? error}`));
  };
  setTimeout(check, 60 * 1000);
  setInterval(check, UPDATE_EVERY_MS);
}

/** "1.10.0" > "1.9.2". */
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** 24spells says which versions still work with the site; an older one asks to update. */
async function checkMinimumVersion() {
  try {
    const r = await fetch(`${SITE}/overlay/latest.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const latest = await r.json();
    needsUpdate = latest?.min && newer(latest.min, app.getVersion()) ? latest.version ?? latest.min : null;
    if (needsUpdate) {
      logData(`update: this version is below the minimum (${latest.min}); asking to update`);
      setStatus('Update needed');
    }
    refreshTray();
  } catch {
    // Offline: check again later.
  }
}

// ---------- Start ----------
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  stopForegroundHelper();
  watcher?.stop();
});

app.whenReady().then(() => {
  protocol.handle('overlay', async (request) => {
    const relative = path.normalize(decodeURIComponent(new URL(request.url).pathname).slice(1));
    const target = path.join(APP_DIR, relative);
    if (relative.startsWith('..') || !target.startsWith(APP_DIR) || !MIME[path.extname(target)]) {
      return new Response('Not found', { status: 404 });
    }
    try {
      return new Response(await readFile(target), {
        headers: { 'content-type': MIME[path.extname(target)] },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  const smokeShot = process.env.OVERLAY_SMOKE_SHOT;
  if (smokeShot) {
    runSmokeTest(smokeShot);
    return;
  }

  applyStartWithWindows(readSettings().startWithWindows);
  tray = new Tray(trayIcon());
  arena = createArenaRecorder({
    userDir: USER_DIR,
    logPath: LOG_PATH,
    namesFor,
    onChange: () => {
      refreshTray();
      sendAccount();
      if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('setup:changed');
    },
    log: logData,
    share: () => readSettings().share,
  });
  if (!readSettings().setupDone || process.env.OVERLAY_SETUP_SHOT) {
    const win = openSetup();
    const shot = process.env.OVERLAY_SETUP_SHOT;
    if (shot) {
      win.webContents.once('did-finish-load', () =>
        setTimeout(async () => {
          writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
          app.quit();
        }, 1500),
      );
    }
  }
  startUpdater();
  void checkMinimumVersion();
  setInterval(() => void checkMinimumVersion(), 24 * 60 * 60 * 1000);
  setTimeout(() => void arena.scanAll(), 15_000);
  refreshTray();
  overlay = createOverlay();
  void pollArena();
  setInterval(() => void pollArena(), ARENA_POLL_MS);
  setTimeout(() => void refreshInBackground('app started'), REFRESH_FIRST_MS);
  setInterval(() => void refreshInBackground('every 6 hours'), REFRESH_EVERY_MS);
  // 0.3.7: hosted stats are a tiny index check, so look every 15 minutes: new data reaches every
  // overlay within 15 minutes of a site publish, no restart. (Local builds stay on the 6-hour cycle.)
  setInterval(() => {
    if (!readSettings().localBuild) void refreshHosted('every 15 minutes');
  }, HOSTED_CHECK_MS);
});

// ---------- Sealed: build your pool in 24spells (2026-11-14) ----------
// Arena lists every event you are in with its card pool; for a sealed event that is the pool you
// opened. The newest one, from the live log, the previous log or an archived copy, goes to 24spells
// as a card list in the link (#pool=...), which opens the site's import with the set's sealed numbers.
async function latestSealedPool() {
  const files = [LOG_PATH, path.join(path.dirname(LOG_PATH), 'Player-prev.log')];
  const archive = path.join(USER_DIR, 'arena-logs');
  try {
    for (const name of readdirSync(archive)) if (/\.log(\.gz)?$/.test(name)) files.push(path.join(archive, name));
  } catch {
    // No archive yet.
  }
  let best = null;
  for (const file of files) {
    let text;
    try {
      const buf = readFileSync(file);
      text = file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    } catch {
      continue;
    }
    if (!text.includes('Sealed_')) continue;
    for (const p of readArenaLog(text).sealed) if (!best || (p.at ?? 0) > (best.at ?? 0)) best = p;
  }
  if (!best) return null;
  const names = namesFor(best.set, [...new Set(best.pool)]);
  const counts = new Map();
  let unknown = 0;
  for (const id of best.pool) {
    const n = names[id];
    if (!n) { unknown += 1; continue; }
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const list = [...counts].map(([n, c]) => `${c} ${n}`).join('\n');
  return { set: best.set, event: best.event, at: best.at, wins: best.wins, losses: best.losses, cards: best.pool.length, unknown, list,
    url: `/?set=${best.set}#pool=${encodeURIComponent(list)}` };
}
ipcMain.handle('overlay:sealed-pool', async () => latestSealedPool());
async function openSealedPool() {
  const p = await latestSealedPool();
  if (!p) {
    logData('sealed: no sealed pool in Arena\'s logs yet');
    return false;
  }
  logData(`sealed: opening ${p.set} pool (${p.cards} cards${p.unknown ? `, ${p.unknown} unnamed` : ''}) in 24spells`);
  void shell.openExternal(p.url);
  return true;
}

// ---------- Review in 24spells (2026-11-13) ----------
// The current draft, read straight from Arena's log (complete even if the overlay
// restarted mid-draft): every pick's pack and the card taken. The renderer turns it
// into a 24spells link; the draft travels in the link itself, nothing is uploaded.
ipcMain.handle('overlay:review', async () => {
  let text;
  try {
    text = await readFile(LOG_PATH, 'utf8');
  } catch {
    return null;
  }
  let setCode = null;
  let format = null;
  let draftId = null;
  let current = null;
  let picks = [];
  for (const line of text.split('\n')) {
    const event = parseLogLine(line);
    if (!event) continue;
    if (event.type === 'joined') {
      setCode = event.setCode;
      format = event.format;
    } else if (event.type === 'pack') {
      if ((event.draftId && event.draftId !== draftId) || (event.packNumber === 1 && event.pickNumber === 1)) {
        picks = [];
        draftId = event.draftId ?? draftId;
      }
      setCode = event.setCode ?? setCode;
      format = event.format ?? format;
      current = { pack: event.packNumber, pick: event.pickNumber, cards: event.cardIds };
    } else if (event.type === 'pick' && current) {
      picks.push({ ...current, taken: event.cardIds[0] ?? null });
      current = null;
    }
  }
  return picks.length ? { setCode, format, picks } : null;
});

// The newest recorded run, opened on 24spells (works after Arena replaced its log).
ipcMain.handle('overlay:latest-run', async () => (arena ? arena.latest() : null));

// 0.3.9 (Ken 2026-11-16: "how do we make them connect their account"): the overlay shows a
// Connect to 24spells button inside Arena, only while this PC is not linked.
function accountState() {
  if (!arena) return null;
  const s = arena.status();
  return { connected: s.connected ?? null, pairing: s.pairing };
}
function sendAccount() {
  const state = accountState();
  if (state && overlay && !overlay.isDestroyed() && !overlay.webContents.isLoading()) {
    overlay.webContents.send('overlay:account', state);
  }
}
ipcMain.handle('overlay:account', () => accountState());
ipcMain.handle('overlay:connect', () => {
  arena?.connect((url) => shell.openExternal(url));
  sendAccount();
});

ipcMain.handle('overlay:open-review', (_event, link) => {
  // The overlay page sends a path on the site ("/?set=...#review=..."); only the site is ever opened.
  if (typeof link !== 'string' || !link.startsWith('/')) {
    return false;
  }
  void shell.openExternal(`${SITE}${link}`);
  return true;
});
