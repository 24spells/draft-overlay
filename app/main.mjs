// The real app. Sits idle in the tray until Arena opens, then starts the
// 17Lands client, follows Arena's log, and draws stats on draft packs.
// Reads the log and window positions only. Never touches Arena's memory.

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
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

const ROOT = app.getAppPath();
const APP_DIR = path.join(ROOT, 'app');
// Installed copies keep data in the user's app folder, since the install folder is replaced on update.
const USER_DIR = app.isPackaged ? app.getPath('userData') : ROOT;
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
/** Real drafts and games, recorded and sent to 23spells (see arena-sync.mjs). */
let arena = null;
// A draft or game just ended: re-read the log for records.
const RECORD_MARKERS = ['GameStage_GameOver', 'MatchGameRoomStateType_MatchCompleted', 'DraftCompleteDraft', 'EventSetDeck'];
let statusText = 'Waiting for Arena';
const statsCache = new Map();
const dataChecked = new Set();
let refreshing = false;
let refreshPending = false;
let lastPackAt = 0;
// The view clears after every pick, so "drafting" means a pack in the last 5 minutes.
const DRAFT_QUIET_MS = 5 * 60 * 1000;
const drafting = () => Date.now() - lastPackAt < DRAFT_QUIET_MS;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'app-settings.json');

function readSettings() {
  try {
    return { startWithWindows: true, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { startWithWindows: true };
  }
}

function applyStartWithWindows(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: app.isPackaged ? [] : [ROOT],
  });
  writeFileSync(settingsPath(), JSON.stringify({ startWithWindows: enabled }));
}

// ---------- Tray ----------
function trayIcon() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0x6b; // blue
    pixels[i + 1] = 0xd0; // green
    pixels[i + 2] = 0xf2; // red
    pixels[i + 3] = 0xff;
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function refreshTray() {
  if (!tray) {
    return;
  }
  tray.setToolTip(`Draft Overlay: ${statusText}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Draft Overlay: ${statusText}`, enabled: false },
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
      { label: `23spells: not connected (${games})`, enabled: false },
      { label: 'Connect to 23spells...', click: () => arena.connect((url) => shell.openExternal(url)) },
    ];
  }
  return [
    { label: `23spells: ${s.connected}${s.waiting ? `, ${s.waiting} to send` : ', all sent'}${s.error ? ` (${s.error})` : ''}`, enabled: false },
    { label: 'Open my Arena games', click: () => void shell.openExternal('https://23spells.pages.dev/#arena') },
    { label: 'Send now', click: () => void arena.scanAll() },
    { label: 'Disconnect from 23spells', click: () => arena.disconnect() },
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
  if (!setCode || dataChecked.has(setCode) || builtAt(setCode) !== null) {
    return;
  }
  dataChecked.add(setCode);
  setStatus(`Updating ${setCode} stats`);
  const ok = await runBuild(setCode);
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

// ---------- The web trainer's coach files (23spells) ----------
// The coach hint runs the trainer's engine on the trainer's own set files, so
// the overlay and the site agree. Cached on disk; refreshed at most daily, in
// the background, so a draft never waits on the network once a set is cached.
const COACH_SITE = 'https://23spells.pages.dev/sets';
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
  if (!existsSync(CLIENT_SHORTCUT) || (await isRunning(CLIENT_IMAGE))) {
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
  arena = createArenaRecorder({ userDir: USER_DIR, logPath: LOG_PATH, namesFor, onChange: refreshTray, log: logData });
  setTimeout(() => void arena.scanAll(), 15_000);
  refreshTray();
  overlay = createOverlay();
  void pollArena();
  setInterval(() => void pollArena(), ARENA_POLL_MS);
  setTimeout(() => void refreshInBackground('app started'), REFRESH_FIRST_MS);
  setInterval(() => void refreshInBackground('every 6 hours'), REFRESH_EVERY_MS);
});

// ---------- Review in 23spells (2026-11-13) ----------
// The current draft, read straight from Arena's log (complete even if the overlay
// restarted mid-draft): every pick's pack and the card taken. The renderer turns it
// into a 23spells link; the draft travels in the link itself, nothing is uploaded.
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

ipcMain.handle('overlay:open-review', (_event, url) => {
  if (typeof url !== 'string' || !url.startsWith('https://23spells.pages.dev/')) {
    return false;
  }
  void shell.openExternal(url);
  return true;
});
