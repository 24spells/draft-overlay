// The on-screen overlay. Plain DOM with no framework, so the same code runs
// in the browser preview and in the real app.

import { mountMullPlate } from './mull-plate.ts';
import { coachRead, createCoach, gradeTaken, PackMemory, type Coach, type CoachRead, type PackInput, type PickResult } from './coach-hint.ts';
import { gradeScore } from '../core/grades.ts';
import { factLines, pairName } from '../coach/facts.ts';
import { ROLE_LABELS } from '../coach/roles.ts';
import {
  cardRect,
  gridGeometry,
  positionCards,
  type Calibration,
} from '../core/layout.ts';
import {
  autoDeck,
  averageValues,
  COLOR_PAIRS,
  formatMetric,
  METRIC_IDS,
  METRICS,
  rateSet,
  type CardRow,
  type GradeBasis,
  type MetricId,
} from '../core/stats.ts';
import type {
  AccountState,
  CardMeta,
  DraftView,
  LoadedStats,
  OverlayApi,
  StatLineFile,
} from '../core/types.ts';

type MainStat = MetricId | 'grade';
type SmallStat = MetricId | 'none';

type Settings = {
  main: MainStat;
  small: [SmallStat, SmallStat, SmallStat];
  gradeStyle: 'letter' | 'score';
  basis: GradeBasis;
  deck: string;
  players: 'all' | 'top';
  minGames: number;
  lowSample: 'dash' | 'dim';
  calibration: Calibration;
  /** The Stats ON/OFF button. Off hides the card plates but keeps the panel. */
  showStats: boolean;
  /** The ▼ Close button. Folded leaves one small tab on screen. */
  folded: boolean;
  /** The Coach ON/OFF button: outline the coach's top picks, like the 24spells hint. On by default. */
  coachHint: boolean;
  /** Ranked shows 1, 2, 3 on the outlined cards; outline only is the trainer's unranked hint (your call). */
  coachStyle: 'ranked' | 'outline';
  /** How many top picks to mark. */
  coachCount: number;
  /** Live: marks on the pack. After you pick: no marks; the coach's pick and your grade show once you have chosen (training). */
  coachMode: 'live' | 'after';
  /** On ranked marks, how far each pick is behind #1 (win-rate points). */
  coachGaps: boolean;
  /** A stack row with your likely colors and the chance of a splash or 3+ colors. */
  coachColors: boolean;
  /** After each pick: a chess-style grade, and the draft's running accuracy. */
  coachGrades: boolean;
  /** 0.3.8 (Ken: "overlay often blocks visuals of cards"): compact = the grade and one number in the
   * art's corner; full = the grade and all small stats across the card. */
  plateStyle: 'compact' | 'full';
  /** A stack row with the flow meter: which colors are reaching you more than usual (the trainer's). */
  coachFlow: boolean;
};

const DEFAULTS: Settings = {
  main: 'grade',
  small: ['gih', 'iwd', 'ata'],
  gradeStyle: 'letter',
  basis: 'gih',
  deck: 'ALL',
  players: 'all',
  minGames: 500,
  lowSample: 'dash',
  calibration: { x: 0, y: 0, scale: 1 },
  showStats: true,
  folded: false,
  coachHint: true,
  coachStyle: 'ranked',
  coachCount: 3,
  coachMode: 'live',
  coachGaps: true,
  coachColors: true,
  coachGrades: true,
  plateStyle: 'compact',
  coachFlow: true,
};

/** Arena's enlarged card spans about this many card widths beside the hovered card (measured 2026-11-16). */
const ZOOM_SPAN = 3.5;
const FLOW_ORDER = ['W', 'U', 'B', 'R', 'G'] as const;
const FLOW_NAMES: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const FLOW_FILL: Record<string, string> = { W: '#f3ecc8', U: '#6fb3e6', B: '#a99fa2', R: '#ef8a6b', G: '#73c48a' };
/** Scores beyond this fill the bar; typical reads run about -1 to +1.5 (same as the trainer). */
const FLOW_MAX = 1.5;
/** How often a "flowing" color was truly open, from the trainer's simulated drafts (validate-flow.ts, 2026-11-11). */
const FLOW_TRUST = [
  'Pack 1 is an early read: colors marked flowing were truly open only a little more often than chance. Note it, do not commit to it.',
  'In testing, colors marked flowing in pack 2 were truly open about two times in three.',
  'In testing, colors marked flowing in pack 3 were truly open about three times in four (same neighbors as pack 1).',
];

const BADGE_GLYPH: Record<string, string> = { Best: '★', Excellent: '!', Good: '✓', Inaccuracy: '?!', Mistake: '?', Blunder: '??' };
const BADGE_COLOR: Record<string, string> = { Best: '#81b64c', Excellent: '#5eb3a2', Good: '#95b776', Inaccuracy: '#f2c037', Mistake: '#ff9a47', Blunder: '#f2493a' };
/** A pair in the usual WUBRG order: "UB", not the sorted "BU". */
const wubrg = (colors: string) => [...colors].sort((a, b) => 'WUBRG'.indexOf(a) - 'WUBRG'.indexOf(b)).join('');

const FORMAT_NAMES: Record<string, string> = {
  PremierDraft: 'Premier',
  QuickDraft: 'Quick',
  TraditionalDraft: 'Traditional',
};

/** Short names for the panel dropdown, where the full labels do not fit. */
function compactMetric(id: MetricId): string {
  if (id === 'games') {
    return 'Games';
  }
  return ['gih', 'oh', 'gd', 'gp', 'gns'].includes(id)
    ? `${METRICS[id].short} WR`
    : METRICS[id].short;
}

const STORAGE_KEY = 'draft-overlay.settings.v1';
const INTERACTION_PADDING = 24;

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      ...DEFAULTS,
      ...stored,
      calibration: { ...DEFAULTS.calibration, ...stored.calibration },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function option(select: HTMLSelectElement, value: string, label: string): void {
  const node = element('option', undefined, label);
  node.value = value;
  select.append(node);
}

/** Wraps a select so it can carry the custom chevron. */
function wrapSelect(select: HTMLSelectElement): HTMLElement {
  const wrap = element('span', 'select-wrap');
  wrap.append(select);
  return wrap;
}

// ---------- The site's hover panel (draft-trainer CardStats + CardNotes), 2026-11-15 ----------
// Ken: "our overlay vs our hover should match ... the current hover on the site". Same sections,
// same labels, same percentile math and colors; built in plain DOM here.

/** Stats where a lower number is better (taken earlier = valued more). */
const LOWER_IS_BETTER: MetricId[] = ['ata', 'alsa'];
const RANKED: MetricId[] = ['gih', 'oh', 'gd', 'gp', 'iwd', 'ata', 'alsa'];
const BASIC_LANDS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);

type Ranks = { percentiles: Map<string, Partial<Record<MetricId, number>>>; poolSize: number };

/** Each card's percentile (1-99) among the set's cards with enough games: the site's rankAll. */
function rankAll(rows: Map<string, CardRow>): Ranks {
  const pool = [...rows.values()].filter((row) => !row.lowSample && !BASIC_LANDS.has(row.name));
  const percentiles = new Map<string, Partial<Record<MetricId, number>>>();
  for (const metric of RANKED) {
    const values = pool.map((row) => row.values[metric]).filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (values.length === 0) continue;
    for (const row of rows.values()) {
      const value = row.values[metric];
      if (value === null || BASIC_LANDS.has(row.name)) continue;
      let below = 0;
      let equal = 0;
      for (const v of values) {
        if (v < value) below += 1;
        else if (v === value) equal += 1;
      }
      let pct = ((below + equal / 2) / values.length) * 100;
      if (LOWER_IS_BETTER.includes(metric)) pct = 100 - pct;
      const entry = percentiles.get(row.name) ?? {};
      entry[metric] = Math.max(1, Math.min(99, Math.round(pct)));
      percentiles.set(row.name, entry);
    }
  }
  return { percentiles, poolSize: pool.length };
}

// The same scale as the grade badges: red (F) to green (A).
const PCT_SCALE: [number, [number, number, number]][] = [
  [0, [239, 107, 107]],
  [25, [240, 163, 90]],
  [50, [217, 211, 106]],
  [75, [155, 211, 106]],
  [100, [95, 211, 141]],
];

function percentileColor(pct: number): string {
  for (let i = 1; i < PCT_SCALE.length; i += 1) {
    const [hi, c1] = PCT_SCALE[i];
    if (pct <= hi) {
      const [lo, c0] = PCT_SCALE[i - 1];
      const t = (pct - lo) / (hi - lo);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * t)).join(' ')})`;
    }
  }
  return `rgb(${PCT_SCALE[PCT_SCALE.length - 1][1].join(' ')})`;
}

// The site's CardStats (2026-11-16 redesign): sub-labels, no "In the deck", Lift when cast, one draft-demand row.
const PERFORMANCE: { metric: MetricId; label: string; sub?: string }[] = [
  { metric: 'gih', label: 'When in hand' },
  { metric: 'oh', label: 'In opening hand', sub: 'keep value' },
  { metric: 'gd', label: 'Drawn later', sub: 'top-deck value' },
  { metric: 'iwd', label: 'Lift when drawn' },
];

const signed = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}`;

/** "Plays best in": fast games on the left, slow on the right; 12 points of lean reaches the end (the site's slider). */
function leanBlock(lean: number | undefined, why: string | null): HTMLElement {
  const side = lean === undefined ? null : Math.abs(lean) < 2 ? 'any' : lean > 0 ? 'aggro' : 'control';
  const block = element('div', side === null ? 'lean empty' : 'lean');
  if (side) block.dataset.side = side;
  const head = element('div', 'lean-head');
  head.append(element('span', undefined, 'Plays best in'), element('strong', undefined, side === null ? '-' : side === 'any' ? 'Any game speed' : side === 'aggro' ? 'Fast games' : 'Slow games'));
  const rail = element('div', 'lean-rail');
  if (lean !== undefined) {
    const at = Math.max(4, Math.min(96, 50 - (lean / 12) * 46));
    const fill = element('span', 'lean-fill');
    fill.style.left = `${Math.min(50, at)}%`;
    fill.style.width = `${Math.abs(at - 50)}%`;
    const thumb = element('span', 'lean-thumb');
    thumb.style.left = `${at}%`;
    rail.append(fill, element('span', 'lean-center'), thumb);
  } else rail.append(element('span', 'lean-center'));
  const ends = element('div', 'lean-ends');
  ends.append(element('span', undefined, 'Fast'), element('span', undefined, 'Any'), element('span', undefined, 'Slow'));
  block.append(head, rail, ends);
  if (side === null && why) block.append(element('small', 'lean-why', why));
  return block;
}

/** "Taken around": where drafters take it, on a pick 1 to 14 scale (its price, not its quality). */
function pickRow(label: string, value: number | null): HTMLElement {
  const row = element('div', 'pick-row');
  const rail = element('div', 'pick-rail');
  if (value !== null) {
    const mark = element('span', 'pick-mark');
    mark.style.left = `${Math.max(0, Math.min(100, ((value - 1) / 13) * 100))}%`;
    rail.append(mark);
  }
  rail.append(element('small', 'p1', '1'), element('small', 'p14', '14'));
  row.append(element('span', 'sb-label', label), rail, element('span', 'sb-value', value === null ? '-' : `pick ${value.toFixed(1)}`));
  return row;
}

function statValue(metric: MetricId, value: number | null): string {
  if (value === null) return '-';
  if (metric === 'iwd') return `${formatMetric(metric, value)} pts`;
  if (metric === 'ata' || metric === 'alsa') return `pick ${value.toFixed(1)}`;
  return `${value.toFixed(1)}%`;
}

/** One Savant-style row: label, a percentile track with a colored dot, value (the site's StatBar). */
function statBar(label: string, value: string, pct: number | null, dim: boolean, sub?: string): HTMLElement {
  const bar = element('div', dim ? 'sb-row dim' : 'sb-row');
  const track = element('div', 'sb-track');
  if (pct !== null) {
    const color = percentileColor(pct);
    const fill = element('div', 'sb-fill');
    fill.style.width = `${pct}%`;
    fill.style.background = color;
    const dot = element('div', 'sb-dot', String(pct));
    dot.style.left = `${pct}%`;
    dot.style.background = color;
    track.append(fill, dot);
  }
  const labelEl = element('span', 'sb-label', label);
  if (sub) labelEl.append(element('small', 'sb-sub', sub));
  bar.append(labelEl, track, element('span', 'sb-value', value));
  return bar;
}

function sectionHead(title: string, note: string): HTMLElement {
  const head = element('h4', 'sb-head', title);
  head.append(element('span', undefined, note));
  return head;
}

/** A color pair as two mana pips, like the site's {U}{B}. */
function pairPips(pair: string): HTMLElement {
  const wrap = element('span', 'pips');
  for (const color of pair) wrap.append(element('span', `pip pip-${color.toLowerCase()}`));
  return wrap;
}

function gradeClass(row: CardRow | undefined): string {
  return `grade-${row?.grade?.charAt(0).toLowerCase() ?? 'none'}`;
}

type Placed = {
  id: number;
  meta: CardMeta | undefined;
  row: CardRow | undefined;
  column: number;
  rowIndex: number;
  rect: { left: number; top: number; width: number; height: number };
  plate: HTMLElement;
};

export function mountOverlay(root: HTMLElement, api: OverlayApi): void {
  const settings = loadSettings();
  let view: DraftView | null = null;
  /** The last pack shown, so the panel can say "waiting for the next pack" between picks (2026-11-13). */
  let lastView: DraftView | null = null;
  let loaded: LoadedStats | null = null;
  let loadedFor = '';
  let hidden = false;
  let placed: Placed[] = [];
  /** The coach outlines drawn this pack, so the ones under Arena's enlarged card can hide too (0.3.13). */
  let rings: { id: number; rect: Placed['rect']; el: HTMLElement }[] = [];
  let hovered: Placed | null = null;
  let panelOpen = false;
  /** Outside a draft the stack shows as a folded tab until clicked open. */
  let peek = false;
  let interactive = false;
  let mouseX = -1;
  let mouseY = -1;
  let averages: Record<MetricId, number | null> | null = null;
  /** Percentiles for the hover panel, on the same rating as the plates. */
  let ranks: Ranks | null = null;
  /** The web trainer's coach for the set in front of you (null until loaded, or if the site has no such set). */
  let coach: Coach | null = null;
  let coachFor = '';
  /** The set's slash line (fast vs slow games, Lift when cast): null = not loaded, false = 24spells has none. */
  let statline: StatLineFile | false | null = null;
  let statlineFor = '';
  /** Arena card id -> the coach's rank for it (1 = best) and points behind #1, for the pack on screen. */
  let coachTop = new Map<number, { rank: number; gap: number }>();
  let coachView: CoachRead | null = null;
  /** The last pack the coach read, to grade the pick you make from it. */
  let lastInput: PackInput | null = null;
  /** This draft's graded picks (for the running accuracy). */
  let grades: { draftId: string | null; results: PickResult[] } = { draftId: null, results: [] };
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const packMemory = new PackMemory();

  root.classList.add('draft-overlay');
  const plates = element('div', 'plates');
  const hoverPanel = element('aside', 'hover-panel');
  const controls = element('div', 'controls');
  const stack = element('div', 'toggle-stack');
  const setInfo = element('div', 'stack-row stack-info');
  const statsButton = element('button', 'stack-row stack-button stats-toggle');
  const coachButton = element('button', 'stack-row stack-button stats-toggle coach-toggle');
  const colorsRow = element('div', 'stack-row stack-info coach-colors');
  const gradeRow = element('div', 'stack-row stack-info coach-grade');
  const flowRow = element('div', 'stack-row stack-info coach-flow');
  const toast = element('div', 'pick-toast');
  coachButton.title = "Outline the coach's top 3 picks, the same hint as on 24spells";
  const mainLabel = element('label', 'stack-row stack-select');
  const mainSelect = element('select');
  const deckLabel = element('label', 'stack-row stack-select');
  const deckSelect = element('select');
  const settingsButton = element('button', 'stack-row stack-button settings-button', 'Settings');
  // 2026-11-13: send this draft to 24spells for the full review and deck building.
  const reviewButton = element('button', 'stack-row stack-button review-button', 'Review in 24spells');
  reviewButton.title = 'Open this draft on 24spells: every pick graded, then build your deck with the coach, the laws of drafting and synergy. The draft travels in the link; nothing is uploaded.';
  // 0.3.9 (Ken 2026-11-16): only while this PC is not linked to a 24spells account.
  const connectButton = element('button', 'stack-row stack-button connect-button');
  connectButton.title = 'Send your Arena drafts and games to your Record on 24spells. Opens 24spells to sign in with Discord.';
  let account: AccountState | null = null;
  const foldButton = element('button', 'stack-row stack-button fold-button');
  for (const button of [statsButton, coachButton, reviewButton, connectButton, settingsButton, foldButton]) {
    button.type = 'button';
  }
  const panel = element('section', 'settings-panel');
  const status = element('p', 'status');
  const credit = element('p', 'credit');

  mainLabel.append(element('span', 'stack-label', 'Show'), wrapSelect(mainSelect));
  deckLabel.append(element('span', 'stack-label', 'Compare'), wrapSelect(deckSelect));
  stack.append(connectButton, setInfo, statsButton, coachButton, colorsRow, flowRow, gradeRow, mainLabel, deckLabel, reviewButton, settingsButton, foldButton);
  controls.append(stack, panel, status, credit);
  root.append(plates, hoverPanel, controls, toast);

  option(mainSelect, 'grade', 'Grade');
  METRIC_IDS.forEach((id) => option(mainSelect, id, compactMetric(id)));
  option(deckSelect, 'AUTO', 'Auto');
  option(deckSelect, 'ALL', 'All decks');
  COLOR_PAIRS.forEach((pair) => option(deckSelect, pair, pair));

  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Settings still apply for this session.
    }
  }

  function activeDeck(): { key: string; label: string } {
    if (settings.deck !== 'AUTO') {
      return {
        key: settings.deck,
        label: settings.deck === 'ALL' ? 'All decks' : settings.deck,
      };
    }
    const picked =
      loaded && view ? autoDeck(loaded.stats, view.pickedCardIds) : null;
    // Early data has no per-pair stats: stay on all decks rather than show blanks.
    const auto =
      picked && loaded?.stats.groups[`${picked}|${settings.players}`] ? picked : null;
    return auto
      ? { key: auto, label: `Auto: ${auto}` }
      : { key: 'ALL', label: 'Auto: all decks' };
  }

  function mainDisplay(row: CardRow | undefined): { text: string; wide: boolean } {
    if (!row || (row.lowSample && settings.lowSample === 'dash')) {
      return { text: '-', wide: false };
    }
    if (settings.main !== 'grade') {
      return { text: formatMetric(settings.main, row.values[settings.main]), wide: true };
    }
    if (row.gradeIndex === null) {
      return { text: '-', wide: false };
    }
    return settings.gradeStyle === 'score'
      ? { text: gradeScore(row.gradeIndex).toFixed(1), wide: false }
      : { text: row.grade!, wide: false };
  }

  function smallDisplay(row: CardRow | undefined, metric: MetricId): string {
    if (!row) {
      return '-';
    }
    const isDraftStat = metric === 'ata' || metric === 'alsa' || metric === 'games';
    if (row.lowSample && settings.lowSample === 'dash' && !isDraftStat) {
      return '-';
    }
    return formatMetric(metric, row.values[metric]);
  }

  function buildPlate(entry: Omit<Placed, 'plate'>, scale: number): HTMLElement {
    const compact = settings.plateStyle === 'compact';
    const plate = element('div', `plate ${gradeClass(entry.row)}${compact ? ' compact' : ''}`);
    plate.style.left = `${entry.rect.left + entry.rect.width * 0.05}px`;
    plate.style.top = `${entry.rect.top + entry.rect.height * 0.13}px`;
    if (!compact) plate.style.width = `${entry.rect.width * 0.9}px`;
    plate.style.setProperty('--u', `${scale}px`);
    if (entry.row?.lowSample && settings.lowSample === 'dim') {
      plate.classList.add('low-sample');
    }

    const main = mainDisplay(entry.row);
    const mainCell = element('div', main.wide ? 'main wide' : 'main', main.text);
    plate.append(mainCell);

    const smalls = settings.small
      .filter((metric): metric is MetricId => metric !== 'none')
      .slice(0, compact ? 1 : 3);
    if (smalls.length > 0) {
      const list = element('div', 'smalls');
      for (const metric of smalls) {
        const cell = element('div', 'small');
        cell.append(
          element('span', 'small-label', METRICS[metric].short),
          element('span', 'small-value', smallDisplay(entry.row, metric)),
        );
        list.append(cell);
      }
      plate.append(list);
    }
    return plate;
  }

  function renderPlates(): void {
    plates.textContent = '';
    placed = [];
    rings = [];
    hovered = null;
    hoverPanel.classList.remove('visible');

    const outlines = settings.coachHint && settings.coachMode === 'live' && coachTop.size > 0;
    if (!view || !loaded || hidden || (!settings.showStats && !outlines)) {
      return;
    }

    const set = loaded.stats;
    const ratings = rateSet(set, {
      deck: activeDeck().key,
      players: settings.players,
      basis: settings.basis,
      minGames: settings.minGames,
    });
    averages = averageValues(ratings);
    ranks = rankAll(ratings);
    const geometry = gridGeometry(
      window.innerWidth,
      window.innerHeight,
      settings.calibration,
    );
    const cards = view.cardIds.map((id) => ({
      id,
      meta: set.cards[String(id)],
      rarity: set.cards[String(id)]?.rarity,
      // Arena sorts by the color you pay for. 17Lands' color identity also counts mana symbols in the
      // rules text (Mardu Devotee: W, not BRW), which shifted every card after it (amaze, TDM, 2026-11-17).
      color: set.cards[String(id)]?.castColor ?? set.cards[String(id)]?.color,
      isLand: set.cards[String(id)]?.isLand,
    }));

    for (const { card, column, row } of positionCards(cards)) {
      const rect = cardRect(column, row, geometry);
      if (outlines && coachTop.has(card.id)) {
        // The coach's top picks: outlined (the trainer's hint look), ranked if chosen.
        const { rank, gap } = coachTop.get(card.id)!;
        const ring = element('div', `coach-outline${rank === 1 && settings.coachStyle === 'ranked' ? ' first' : ''}`);
        if (settings.coachStyle === 'ranked') {
          ring.append(element('span', 'coach-rank', String(rank)));
          // How far behind #1: a near tie reads as one, a clear gap as a clear gap.
          if (settings.coachGaps && rank > 1) {
            ring.append(element('span', 'coach-gap', gap < 0.5 ? '≈ #1' : `-${gap.toFixed(1)}`));
          }
        }
        ring.style.left = `${rect.left}px`;
        ring.style.top = `${rect.top}px`;
        ring.style.width = `${rect.width}px`;
        ring.style.height = `${rect.height}px`;
        ring.style.setProperty('--u', `${rect.width / 185}px`);
        plates.append(ring);
        rings.push({ id: card.id, rect, el: ring });
      }
      if (!settings.showStats) {
        continue;
      }
      const entry = {
        id: card.id,
        meta: card.meta,
        row: card.meta ? ratings.get(card.meta.name) : undefined,
        column,
        rowIndex: row,
        rect,
      };
      const plate = buildPlate(entry, rect.width / 185);
      plates.append(plate);
      placed.push({ ...entry, plate });
    }

    // Keep the hover panel correct when a redraw happens under a still mouse.
    updateHover(mouseX, mouseY);
  }

  function renderStatus(): void {
    credit.textContent = '';
    status.textContent = '';
    status.classList.remove('visible');
    controls.classList.toggle('shown', !hidden);

    if (!view) {
      return;
    }
    if (!loaded) {
      status.textContent = `No 17Lands public data yet for ${view.setCode ?? 'this set'}. It usually appears about 3 weeks after launch.`;
      status.classList.add('visible');
      return;
    }
    if (loaded.note) {
      status.textContent = loaded.note;
      status.classList.add('visible');
    }
    const through = loaded.stats.source.lastGame?.slice(0, 10) ?? 'unknown';
    credit.textContent = loaded.stats.source.early
      ? `${activeDeck().label}. EARLY DATA from 17Lands.com (no public file yet): win rates under 500 games are hidden, no color-pair or top-player splits. Updated ${through}.`
      : `${activeDeck().label}. Data: 17Lands public dataset, CC BY 4.0. Games through ${through}.`;
    if (settings.coachHint) {
      credit.textContent += coach
        ? ` Coach's top ${settings.coachCount} ${settings.coachStyle === 'ranked' ? 'ranked' : 'outlined'} (24spells coach).`
        : ' Coach hint: no 24spells data for this set yet.';
    }
  }

  type Span = [number, number];
  /**
   * Where Arena draws its enlarged card for the hovered one (0.3.8, measured from a TRK draft at
   * 3200x1800): beside the card, about 3.5 card widths wide, over both rows.
   * 0.3.13-0.3.14 (amaze's and Ken's TDM drafts at 3200x1800): a card that makes a token also shows the
   * token, between the hovered card and the enlarged one, each about 3.5 card widths. The pair goes
   * right of the hovered card only when BOTH fit there, else left (Adorned Crocodile: the card alone
   * fit right, Arena still went left). The text panel (keyword rules, flavor text) goes on the far side
   * of the enlarged card when it fits, else on the other side of the hovered card. Most cards have one.
   */
  function arenaZoom(rect: Placed['rect'], zoomFlags = 0): { left: number; right: number; card: Span; token: Span | null; panels: Span } {
    const W = window.innerWidth;
    const cw = rect.width;
    const span = ZOOM_SPAN * cw;
    const right = rect.left + rect.width;
    const token = zoomFlags & 1 ? span : 0;
    const clamp = (x: number) => Math.max(0, Math.min(W, x));
    const toRight = right + token + span <= W;
    let card: Span;
    let tok: Span | null = null;
    let panels: Span;
    if (toRight) {
      if (token) tok = [right, right + token];
      card = [right + token, right + token + span];
      panels = card[1] + span <= W ? [card[1], card[1] + span] : [rect.left - span, rect.left];
    } else {
      if (token) tok = [rect.left - token, rect.left];
      card = [rect.left - token - span, rect.left - token];
      panels = card[0] - span >= 0 ? [card[0] - span, card[0]] : [right, right + span];
    }
    const c = (x: Span): Span => [clamp(x[0]), clamp(x[1])];
    card = c(card);
    panels = c(panels);
    if (tok) tok = c(tok);
    const all = [card, panels, ...(tok ? [tok] : [])];
    return { left: Math.min(...all.map((x) => x[0])), right: Math.max(...all.map((x) => x[1])), card, token: tok, panels };
  }

  /** Open stretches of the screen between the blocked spans, widest first. */
  function openGaps(blocked: Span[]): Span[] {
    const gaps: Span[] = [];
    let x = 8;
    for (const [a, b] of [...blocked].sort((p, q) => p[0] - q[0])) {
      if (a - 12 > x) gaps.push([x, a - 12]);
      x = Math.max(x, b + 12);
    }
    if (window.innerWidth - 8 > x) gaps.push([x, window.innerWidth - 8]);
    return gaps.sort((p, q) => q[1] - q[0] - (p[1] - p[0]));
  }

  /**
   * The hover panel beside Arena's enlarged card, never over the hovered card or the enlarged card.
   * In order (Ken 2026-11-17, live TDM drafts at 3200x1800): clear of everything Arena shows, if that
   * spot is roomy (a sliver beside the card cut the panel's numbers off); else over the text panel;
   * else over the token; else the widest spot that leaves the enlarged card alone.
   */
  function placeHoverPanel(rect: Placed['rect'], zoomFlags = 0): void {
    const z = arenaZoom(rect, zoomFlags);
    const own: Span = [rect.left, rect.left + rect.width];
    const W = window.innerWidth;
    const ideal = Math.max(400, W * 0.29);
    // Wide enough that every row fits without cutting numbers off.
    const roomy = Math.min(ideal, Math.max(400, W * 0.22));
    const size = (g: Span | undefined) => (g ? g[1] - g[0] : 0);
    const tok = z.token ? [z.token] : [];
    // Safest first (Ken 2026-11-17): the only exact position is the hovered card, and errors grow with
    // distance from it. The away side (beyond the hovered card, opposite the enlarged card) can never
    // hold the enlarged card or the token; the token's slot needs one width guessed; the text panel
    // beyond the enlarged card needs two, and Arena moves it. So: open space, away side, token, text.
    const zoomLeft = z.card[1] <= rect.left;
    const away: Span = zoomLeft ? [own[1] + 12, W - 8] : [8, own[0] - 12];
    const clearAll = openGaps([z.card, z.panels, ...tok, own])[0];
    const overToken = z.token ? openGaps([z.card, z.panels, own])[0] : undefined;
    const overPanels = openGaps([z.card, ...tok, own])[0];
    let gap: Span | undefined =
      size(clearAll) >= roomy ? clearAll
      : size(away) >= roomy ? away
      : size(overToken) >= 280 ? overToken
      : size(overPanels) >= 280 ? overPanels
      : openGaps([z.card, own])[0];
    gap ??= [8, W - 8];
    // Narrow before covering the enlarged card: down to 280px on small screens.
    const width = Math.max(280, Math.min(ideal, gap[1] - gap[0]));
    // Hug the side nearest the enlarged card, so the eye travels the least.
    const nearRight = gap[1] <= z.card[0] || gap[1] <= rect.left;
    const left = nearRight ? gap[1] - width : gap[0];
    hoverPanel.style.width = `${width}px`;
    hoverPanel.style.minWidth = '0';
    hoverPanel.style.right = 'auto';
    hoverPanel.style.left = `${Math.max(8, Math.min(W - width - 8, left))}px`;
  }

  function renderHover(): void {
    const zoom = hovered ? arenaZoom(hovered.rect, hovered.meta?.zoom ?? 0) : null;
    for (const entry of placed) {
      const near =
        hovered !== null &&
        Math.abs(entry.column - hovered.column) <= 1 &&
        Math.abs(entry.rowIndex - hovered.rowIndex) <= 1;
      const underZoom =
        zoom !== null && entry !== hovered && entry.rect.left < zoom.right && entry.rect.left + entry.rect.width > zoom.left;
      entry.plate.classList.toggle('covered', near || underZoom);
    }
    for (const ring of rings) {
      const under = zoom !== null && ring.id !== hovered?.id && ring.rect.left < zoom.right && ring.rect.left + ring.rect.width > zoom.left;
      ring.el.classList.toggle('covered', under);
    }

    hoverPanel.textContent = '';
    hoverPanel.classList.toggle('visible', hovered !== null);
    if (!hovered) {
      return;
    }
    placeHoverPanel(hovered.rect, hovered.meta?.zoom ?? 0);

    const row = hovered.row;
    const name = hovered.meta?.name ?? 'Unknown card';
    const setCode = view?.setCode ?? '';
    const deck = activeDeck().key;
    const within = deck === 'ALL' ? `${setCode} cards` : `${setCode} cards in ${deck} decks`;
    const pcts = ranks?.percentiles.get(name);
    const headline = pcts?.gih ?? null;

    // Grade and headline: the site's CardStats hero, plus the name (no card picture: it's under your mouse).
    const head = element('header', 'hover-head');
    head.append(element('strong', `hover-grade ${gradeClass(row)}`, row?.grade ?? '-'));
    const herotext = element('div', 'hover-herotext');
    herotext.append(element('h3', undefined, name));
    if (row && headline !== null) {
      const line = element('p', 'hover-better', 'Better than ');
      const pct = element('b', undefined, `${headline}%`);
      pct.style.color = percentileColor(headline);
      line.append(pct, ` of ${within}`);
      herotext.append(line);
    }
    if (row?.lowSample) {
      herotext.append(element('p', 'hover-note', `Only ${formatMetric('games', row.values.games)} games: read loosely`));
    }
    head.append(herotext);
    hoverPanel.append(head);

    if (row) {
      // The slash line: null while the set's file loads, false when 24spells has none for this set yet.
      const lines = statlineFor === setCode ? statline : null;
      const sl = lines ? lines.stats[name] : undefined;
      hoverPanel.append(leanBlock(sl?.lean, lines === false ? `No ${setCode} game data yet` : lines ? 'Too few games to tell' : null));
      hoverPanel.append(sectionHead('Performance', `percentile vs ${setCode}`));
      for (const line of PERFORMANCE) {
        hoverPanel.append(statBar(line.label, statValue(line.metric, row.values[line.metric]), pcts?.[line.metric] ?? null, row.lowSample, line.sub));
      }
      if (sl?.wpa !== undefined) hoverPanel.append(statBar('Lift when cast', `${signed(sl.wpa)} pts`, sl.wpaP ?? null, false, 'vs an ordinary turn'));
      else hoverPanel.append(statBar('Lift when cast', '-', null, true, lines === false ? `no ${setCode} replay data yet` : 'vs an ordinary turn'));
      hoverPanel.append(sectionHead('Draft demand', 'its price, not its quality'));
      hoverPanel.append(pickRow('Taken around', row.values.ata));
    } else {
      hoverPanel.append(element('p', 'hover-note', '17Lands has no stats for this card.'));
    }

    // The card notes (the site's CardNotes): what it does, the colors it likes, then the data lines.
    const facts = coach?.facts.get(name);
    const roles = coach?.roles.get(name) ?? [];
    const notes = element('dl', 'hover-notes');
    const noteRow = (label: string, body: HTMLElement | string) => {
      const div = element('div');
      const dd = element('dd');
      dd.append(body);
      div.append(element('dt', undefined, label), dd);
      notes.append(div);
    };
    if (roles.length) {
      const chips = element('span', 'chips');
      for (const r of roles) chips.append(element('span', 'role', ROLE_LABELS[r.role]));
      noteRow('Does', chips);
    }
    const pairs = facts?.pairs ?? [];
    if (pairs.length) {
      const total = pairs.reduce((sum, p) => sum + p.games, 0) || 1;
      const spread = pairs.length > 1 ? pairs[0].rel - pairs[pairs.length - 1].rel : 0;
      const chips = element('span', 'chips');
      pairs.forEach((p, i) => {
        const tone = p.rel >= 1 ? 'good' : p.rel <= -1 ? 'bad' : 'even';
        const chip = element('span', `cp ${tone}${i === 0 && spread >= 3 ? ' best' : ''}`);
        chip.title = `${pairName(p.pair)}: ${p.gih.toFixed(1)}% when in hand`;
        chip.append(pairPips(p.pair), element('b', undefined, `${p.rel >= 0 ? '+' : ''}${p.rel.toFixed(1)}`), element('small', undefined, `${Math.round((100 * p.games) / total)}%`));
        chips.append(chip);
      });
      chips.append(element('span', 'key', 'vs. other cards in that pair · share of its games'));
      noteRow('Colors', chips);
    }
    if (facts) {
      // Left out, as on the site: Keywords (printed on the card), Sample (said above), and Decks when Colors shows it pair by pair.
      for (const l of factLines(facts, setCode).filter((l) => l.label !== 'Keywords' && l.label !== 'Sample' && l.label !== 'Decks')) {
        noteRow(l.label, l.text);
      }
    }
    if (notes.childElementCount) hoverPanel.append(notes);

    if (settings.coachHint && coachTop.has(hovered.id)) {
      hoverPanel.append(
        element(
          'p',
          'hover-coach',
          settings.coachStyle === 'ranked'
            ? `The coach's #${coachTop.get(hovered.id)!.rank} pick here${coachTop.get(hovered.id)!.rank > 1 ? `, ${coachTop.get(hovered.id)!.gap.toFixed(1)} win-rate points behind #1` : ''}.`
            : `One of the coach's top ${settings.coachCount} picks (in no order). Your call.`,
        ),
      );
    }
  }

  function renderStack(): void {
    const folded = view ? settings.folded : !peek;
    stack.classList.toggle('folded', folded);
    for (const row of [setInfo, statsButton, coachButton, mainLabel, deckLabel, settingsButton]) {
      row.hidden = folded;
    }
    renderCoachRows(folded);
    // Always reachable when no pack is on screen (after the draft, at deckbuilding), even folded;
    // during a pack it follows the fold. It reads Arena's log itself, so it works after a restart.
    reviewButton.hidden = !api.getReview || !api.openReview || (!!view && folded);
    // Top of the panel, open or folded, until this PC is connected (Ken 2026-11-16: "so it can't be missed").
    connectButton.hidden = !api.connectAccount || !account || Boolean(account.connected);
    connectButton.textContent = account?.pairing ? 'Finish connecting on 24spells' : 'Connect to 24spells';
    foldButton.textContent = folded ? '▲ Overlay' : '▼ Close';
    foldButton.title = folded ? 'Open the overlay controls' : 'Fold the overlay controls';

    // Panel look (0.3.9, Ken: "make that overlay panel look a little more slick"): set chip + what is open.
    const shownSet = view?.setCode ?? lastView?.setCode ?? loaded?.stats.set ?? null;
    const what = view
      ? (FORMAT_NAMES[view.format] ?? 'Draft')
      : lastView && !(lastView.packNumber >= 3 && lastView.cardIds.length <= 1)
        ? 'Waiting for the next pack'
        : 'No draft open';
    setInfo.textContent = '';
    if (shownSet && (view || what !== 'No draft open')) setInfo.append(element('span', 'set-chip', shownSet));
    setInfo.append(element('span', 'set-what', what));

    switchLabel(statsButton, 'Stats', settings.showStats);
    switchLabel(coachButton, 'Coach', settings.coachHint);
    mainSelect.value = settings.main;
    deckSelect.value = settings.deck;
  }

  /** A toggle row: its name, then a small on/off switch (state also in the title for screen readers). */
  function switchLabel(button: HTMLElement, name: string, on: boolean): void {
    button.textContent = '';
    button.append(element('span', 'switch-name', name), element('span', 'switch'));
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }

  function renderAll(): void {
    renderPlates();
    renderStatus();
    renderStack();
  }

  /** Applies a settings change everywhere, then redraws the panel. */
  function commit(change: () => void): void {
    change();
    save();
    renderAll();
    renderSettings();
  }

  function settingRow(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
    const row = element('div', 'setting-row');
    const label = element('span', 'setting-label', labelText);
    if (hint) {
      label.title = hint;
    }
    row.append(label, control);
    return row;
  }

  function styledSelect(
    value: string,
    options: [string, string][],
    onChange: (value: string) => void,
    titles?: Record<string, string>,
  ): HTMLElement {
    const select = element('select');
    options.forEach(([optionValue, optionLabel]) => {
      option(select, optionValue, optionLabel);
      const title = titles?.[optionValue];
      if (title) {
        select.lastElementChild!.setAttribute('title', title);
      }
    });
    select.value = value;
    select.addEventListener('change', () => commit(() => onChange(select.value)));
    return wrapSelect(select);
  }

  function segmented(
    value: string,
    options: [string, string][],
    onChange: (value: string) => void,
  ): HTMLElement {
    const group = element('div', 'segmented');
    for (const [optionValue, optionLabel] of options) {
      const button = element('button', optionValue === value ? 'on' : undefined, optionLabel);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(optionValue === value));
      button.addEventListener('click', () => commit(() => onChange(optionValue)));
      group.append(button);
    }
    return group;
  }

  /** On/off buttons for boolean settings, any combination. */
  function toggles(items: [keyof Settings, string, string][]): HTMLElement {
    const group = element('div', 'segmented multi');
    for (const [key, label, title] of items) {
      const on = Boolean(settings[key]);
      const button = element('button', on ? 'on' : undefined, label);
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-pressed', String(on));
      button.addEventListener('click', () => commit(() => { (settings as Record<string, unknown>)[key] = !settings[key]; }));
      group.append(button);
    }
    return group;
  }

  function nudgeControl(
    key: keyof Calibration,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
  ): HTMLElement {
    const control = element('div', 'nudge');
    const minus = element('button', 'nudge-step', '−');
    const plus = element('button', 'nudge-step', '+');
    minus.type = 'button';
    plus.type = 'button';
    minus.title = 'Nudge';
    plus.title = 'Nudge';
    const input = element('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(settings.calibration[key]);
    const readout = element('span', 'nudge-value', format(settings.calibration[key]));

    const apply = (value: number): void => {
      const clamped = Math.min(max, Math.max(min, Math.round(value / step) * step));
      settings.calibration[key] = clamped;
      input.value = String(clamped);
      readout.textContent = format(clamped);
      save();
      renderPlates();
    };
    input.addEventListener('input', () => apply(Number(input.value)));
    minus.addEventListener('click', () => apply(settings.calibration[key] - step));
    plus.addEventListener('click', () => apply(settings.calibration[key] + step));
    control.append(minus, input, plus, readout);
    return control;
  }

  const SAMPLE_ROW: CardRow = {
    name: 'Sample card',
    values: { gih: 60.4, oh: 59.1, gd: 61.0, gp: 57.2, gns: 54.0, iwd: 6.4, games: 12850, ata: 3.9, alsa: 2.6 },
    gradeIndex: 8,
    grade: 'B',
    lowSample: false,
  };

  /** The best-graded card in the pack on screen, or a stand-in. */
  function previewRow(): { row: CardRow; caption: string } {
    const best = placed
      .filter((entry) => entry.row?.gradeIndex !== null && entry.row !== undefined)
      .sort((a, b) => b.row!.gradeIndex! - a.row!.gradeIndex!)[0];
    return best?.row
      ? { row: best.row, caption: `Best in this pack: ${best.row.name}` }
      : { row: SAMPLE_ROW, caption: 'Sample card. Open a draft to preview a real one.' };
  }

  function renderSettings(): void {
    panel.textContent = '';
    panel.classList.toggle('open', panelOpen);
    settingsButton.classList.toggle('active', panelOpen);
    if (!panelOpen) {
      return;
    }

    const head = element('header', 'settings-head');
    const close = element('button', 'settings-close', '×');
    close.type = 'button';
    close.title = 'Close settings';
    close.addEventListener('click', () => {
      panelOpen = false;
      renderSettings();
    });
    head.append(element('h2', 'settings-title', 'Overlay settings'), close);

    const preview = element('div', 'settings-preview');
    const sample = previewRow();
    const plate = buildPlate(
      { id: 0, meta: undefined, row: sample.row, column: 0, rowIndex: 0, rect: { left: 0, top: 0, width: 0, height: 0 } },
      1.4,
    );
    plate.classList.add('preview-plate');
    plate.style.left = '';
    plate.style.top = '';
    plate.style.width = '';
    preview.append(plate, element('span', 'preview-caption', sample.caption));

    const metricOptions = METRIC_IDS.map((id) => [id, compactMetric(id)] as [string, string]);
    const metricTitles = Object.fromEntries(METRIC_IDS.map((id) => [id, METRICS[id].label]));

    // The badge itself labels small stats with the short names, so match it.
    const shortOptions = METRIC_IDS.map((id) => [id, METRICS[id].short] as [string, string]);
    const smalls = element('div', 'small-picks');
    settings.small.forEach((value, index) => {
      smalls.append(
        styledSelect(value, [['none', 'None'], ...shortOptions], (next) => {
          settings.small[index] = next as SmallStat;
        }, metricTitles),
      );
    });

    const onCard = section('On the card', [
      settingRow('Size', segmented(settings.plateStyle, [['compact', 'Compact'], ['full', 'Full']], (value) => {
        settings.plateStyle = value as Settings['plateStyle'];
      }), 'Compact: the grade and your first small stat, in the corner of the art. Full: every small stat across the card. Hover a card for all its numbers.'),
      settingRow('Main stat', styledSelect(settings.main, [['grade', 'Grade'], ...metricOptions], (value) => {
        settings.main = value as MainStat;
      }, metricTitles)),
      settingRow('Small stats', smalls),
      settingRow('Grade style', segmented(settings.gradeStyle, [['letter', 'Letter'], ['score', '0 to 5']], (value) => {
        settings.gradeStyle = value as Settings['gradeStyle'];
      })),
    ]);

    const grades = section('Grades', [
      settingRow('Based on', segmented(settings.basis, [['gih', 'GIH'], ['oh', 'OH'], ['gd', 'GD']], (value) => {
        settings.basis = value as GradeBasis;
      }), 'Which win rate the letter grade is built from'),
      settingRow('Players', segmented(settings.players, [['all', 'All'], ['top', 'Top 60%+']], (value) => {
        settings.players = value as Settings['players'];
      }), 'Top: players with about a 60%+ game win rate'),
      settingRow('Min. games', segmented(
        String(settings.minGames),
        [['0', '0'], ['100', '100'], ['250', '250'], ['500', '500'], ['1000', '1k'], ['2000', '2k']],
        (value) => {
          settings.minGames = Number(value);
        },
      ), 'Cards with fewer games in hand get no grade'),
      settingRow('Few games', segmented(settings.lowSample, [['dash', 'Dash'], ['dim', 'Dim']], (value) => {
        settings.lowSample = value as Settings['lowSample'];
      }), 'How to show cards under the minimum'),
    ]);

    const signed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
    const reset = element('button', 'reset-link', 'Reset position');
    reset.type = 'button';
    reset.addEventListener('click', () =>
      commit(() => {
        settings.calibration = { ...DEFAULTS.calibration };
      }),
    );
    const lineUp = section('Line up with the cards', [
      settingRow('Left / right', nudgeControl('x', -5, 5, 0.05, signed)),
      settingRow('Up / down', nudgeControl('y', -5, 5, 0.05, signed)),
      settingRow('Size', nudgeControl('scale', 0.9, 1.1, 0.002, (value) => `${(value * 100).toFixed(1)}%`)),
      reset,
    ]);

    const coachSection = section('Coach', [
      settingRow('Show picks', segmented(settings.coachMode, [['live', 'Live'], ['after', 'After you pick']], (value) => {
        settings.coachMode = value as Settings['coachMode'];
      }), "After you pick: no marks on the pack; you choose first, then see the coach's pick and your grade"),
      settingRow('Marks', segmented(settings.coachStyle, [['ranked', 'Ranked 1-2-3'], ['outline', 'Outline only']], (value) => {
        settings.coachStyle = value as Settings['coachStyle'];
      }), "Outline only is the trainer's hint: the top picks in no order, your call"),
      settingRow('How many', segmented(String(settings.coachCount), [['1', '1'], ['3', '3'], ['5', '5']], (value) => {
        settings.coachCount = Number(value);
        updateCoachTop();
      })),
      settingRow('Also show', toggles([
        ['coachGaps', 'Gaps', 'On ranked marks: win-rate points behind #1'],
        ['coachColors', 'Colors', 'Your likely colors in the stack'],
        ['coachFlow', 'Flow', 'Which colors are reaching you more than usual (the 24spells flow meter)'],
        ['coachGrades', 'Grades', 'A grade after each pick, and your accuracy'],
      ])),
    ]);

    // The mulligan plate (overlay/mull-plate.ts) reads this key; it lives outside Settings so the plate needs no panel.
    const mullOn = (() => {
      try {
        return localStorage.getItem('overlay.mullInfo') !== 'off';
      } catch {
        return true;
      }
    })();
    const games = section('In games', [
      settingRow('Mulligan info', segmented(mullOn ? 'on' : 'off', [['on', 'On'], ['off', 'Off']], (value) => {
        try {
          localStorage.setItem('overlay.mullInfo', value);
        } catch {
          /* private storage off: stays on */
        }
      }), 'At the mulligan prompt: your expected win rate if you keep, and if you mulligan. Numbers only; you decide.'),
    ]);

    panel.append(head, preview, onCard, coachSection, games, grades, lineUp);
  }

  function section(title: string, rows: HTMLElement[]): HTMLElement {
    const block = element('section', 'settings-section');
    block.append(element('h3', undefined, title), ...rows);
    return block;
  }

  function updateHover(x: number, y: number): void {
    const next =
      placed.find(
        ({ rect }) =>
          x >= rect.left &&
          x <= rect.left + rect.width &&
          y >= rect.top &&
          y <= rect.top + rect.height,
      ) ?? null;
    if (next !== hovered) {
      hovered = next;
      renderHover();
    }
  }

  function updateInteractive(x: number, y: number): void {
    // Only the stack and an open settings panel take the mouse. Everything
    // else, including the credit line, stays click-through to Arena.
    const boxes = [stack, ...(panelOpen ? [panel] : [])].map((node) =>
      node.getBoundingClientRect(),
    );
    const inside =
      controls.classList.contains('shown') &&
      boxes.some(
        (bounds) =>
          x >= bounds.left - INTERACTION_PADDING &&
          x <= bounds.right + INTERACTION_PADDING &&
          y >= bounds.top - INTERACTION_PADDING &&
          y <= bounds.bottom + INTERACTION_PADDING,
      );

    if (inside !== interactive) {
      interactive = inside;
      api.setInteractive(inside);
      if (!inside && panelOpen) {
        panelOpen = false;
        renderSettings();
      }
      if (!inside && peek) {
        peek = false;
        renderStack();
      }
    }
  }

  // Review in 24spells: every pick of this draft as trainer card indexes, in the link's #fragment.
  reviewButton.addEventListener('click', async () => {
    if (!api.getReview || !api.openReview) return;
    reviewButton.textContent = 'Opening...';
    try {
      // Connected to 24spells: open the newest recorded run (draft, deck and games), which
      // survives Arena replacing its log at launch (2026-11-13: the button found no draft).
      const latest = api.getLatestRun ? await api.getLatestRun() : null;
      // Sealed (2026-11-14): when your newest event is a sealed one, open its pool on 24spells to build.
      const sealedPool = api.getSealedPool ? await api.getSealedPool() : null;
      if (sealedPool && (!latest || (sealedPool.at ?? 0) >= (latest.at ?? 0))) {
        await api.openReview(sealedPool.url);
        return;
      }
      if (latest) {
        await api.openReview(`/${latest.set ? `?set=${latest.set}` : ''}#arena=${latest.course}`);
        return;
      }
      const data = await api.getReview();
      const set = data?.setCode ?? lastView?.setCode ?? null;
      if (!data || !set) {
        reviewButton.textContent = "No draft in Arena's log yet";
        await new Promise((r) => setTimeout(r, 1800));
        return;
      }
      if (!coach || coach.set !== set) await loadCoach(set);
      if (!coach) return;
      // Card names from the set's stats: load them if no pack has been shown since the overlay started
      // (after a restart, 'loaded' is empty and every card came out unknown: 2026-11-13).
      const stats = loaded && loaded.stats.set === set ? loaded : await api.getSetStats(set, data.format ?? 'PremierDraft', [...data.picks.flatMap((p) => p.cards), ...(data.deck ?? []).map(([id]) => id)]);
      const byName = coach.byName;
      // Names can differ in punctuation between 17Lands and Scryfall ('Set Phasers to . . .'): match loosely too.
      const loose = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
      const byLoose = new Map([...byName].map(([n, i]) => [loose(n), i]));
      const ix = (id: number): number | null => {
        const name = stats?.stats.cards[String(id)]?.name;
        if (!name) return null;
        return byName.get(name) ?? byName.get(name.split(' // ')[0]) ?? byLoose.get(loose(name)) ?? byLoose.get(loose(name.split(' // ')[0])) ?? null;
      };
      const parts = data.picks.map((p) => {
        const taken = p.taken === null ? null : ix(p.taken);
        const shown = p.cards.map(ix).filter((x): x is number => x !== null);
        // '~' marks an unknown card: never a base-36 digit (v1 used 'x', which is also card #33).
        return [taken === null ? '~' : taken.toString(36), ...shown.map((x) => x.toString(36))].join('.');
      });
      if (parts.filter((x) => !x.startsWith('~')).length < data.picks.length / 2) {
        reviewButton.textContent = "Couldn't read this draft's cards";
        await new Promise((r) => setTimeout(r, 2200));
        return;
      }
      // 0.3.14 (thatdoug 2026-11-17: "it should remember the deck"): once you have built your deck in
      // Arena, the link carries it too, so 24spells opens with your 40: spells as card indexes, then
      // basics as W.U.B.R.G counts. Basics Arena names from another set may be unknown: 24spells fills those.
      let deckPart = '';
      if (data.deck?.length) {
        const BASIC = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
        const basics = [0, 0, 0, 0, 0];
        const spells: string[] = [];
        for (const [id, n] of data.deck) {
          const name = stats?.stats.cards[String(id)]?.name ?? '';
          const b = BASIC.indexOf(name);
          if (b >= 0) basics[b] += n;
          else {
            const at = ix(id);
            if (at !== null) for (let k = 0; k < n; k += 1) spells.push(at.toString(36));
          }
        }
        if (spells.length) deckPart = `!${spells.join('.')}!${basics.join('.')}`;
      }
      await api.openReview(`/?set=${set}#review=${deckPart ? 3 : 2}-${set}-${parts.join('_')}${deckPart}`);
    } finally {
      reviewButton.textContent = 'Review in 24spells';
    }
  });

  connectButton.addEventListener('click', () => {
    void api.connectAccount?.();
  });

  settingsButton.addEventListener('click', () => {
    panelOpen = !panelOpen;
    renderSettings();
  });

  statsButton.addEventListener('click', () => {
    settings.showStats = !settings.showStats;
    save();
    renderAll();
  });

  coachButton.addEventListener('click', () => {
    settings.coachHint = !settings.coachHint;
    save();
    renderAll();
  });

  /** The coach's top 3 for the pack in front of you; never lets a coach error take the stats down. */
  function updateCoachTop(): void {
    coachTop = new Map();
    coachView = null;
    if (!coach || !view || !loaded) {
      return;
    }
    try {
      const names = (id: number) => loaded?.stats.cards[String(id)]?.name;
      // The pick you just made, from the pack the coach read last time.
      if (lastInput) {
        const result = gradeTaken(coach, lastInput, view, names);
        if (result) {
          if (grades.draftId !== view.draftId) grades = { draftId: view.draftId, results: [] };
          grades.results.push(result);
          showToast(result);
        }
      }
      coachView = coachRead(coach, view, names, packMemory, settings.coachCount);
      coachTop = coachView.ranks;
      if (coachView.input) lastInput = coachView.input;
    } catch (error) {
      console.error('Coach hint failed', error);
    }
  }

  /** The grade for the pick just made (and, after-you-pick mode, what the coach would have taken). */
  function showToast(result: PickResult): void {
    if (!settings.coachHint || (!settings.coachGrades && settings.coachMode !== 'after')) {
      return;
    }
    toast.textContent = '';
    const color = BADGE_COLOR[result.badge] ?? '#9ca3af';
    toast.style.setProperty('--c', color);
    const glyph = element('span', 'toast-glyph', BADGE_GLYPH[result.badge] ?? '');
    const text = element('span', 'toast-text');
    text.append(element('strong', undefined, settings.coachGrades ? `${result.badge}${result.loss >= 0.05 ? `, -${result.loss.toFixed(1)}` : ''}` : 'Your pick'));
    const same = result.best === result.taken;
    text.append(
      element(
        'span',
        undefined,
        same
          ? `You took the coach's pick: ${result.taken}.`
          : result.badge === 'Best'
            ? `A near tie with the coach's pick, ${result.best}. You took ${result.taken}.`
            : `Coach's pick: ${result.best}. You took ${result.taken}.`,
      ),
    );
    toast.append(glyph, text);
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 4500);
  }

  /** Stack rows: your likely colors, and this draft's accuracy so far. */
  function renderCoachRows(folded: boolean): void {
    const inDraft = Boolean(view) && settings.coachHint && Boolean(coach);
    const odds = coachView?.odds ?? [];
    const showColors = inDraft && settings.coachColors && odds.length > 0 && (view ? view.pickedCardIds.length >= 3 : false);
    colorsRow.hidden = folded || !showColors;
    if (showColors) {
      const top = odds.filter((o) => o.p >= 0.1).slice(0, 2);
      const wide = (coachView?.shapes ?? []).filter((s) => s.shape.kind !== 'pair');
      const wideP = wide.reduce((a, s) => a + s.p, 0);
      colorsRow.textContent = '';
      colorsRow.append(element('span', 'row-cap', 'Your colors'));
      colorsRow.append(element('span', 'coach-row-main', top.map((o) => `${wubrg(o.pair)} ${Math.round(o.p * 100)}%`).join(' · ') || 'Colors open'));
      if (wideP >= 0.15 && wide[0]) {
        const sh = wide[0].shape;
        const label = sh.kind === 'splash' ? `${wubrg(sh.core)}+${sh.splash.toLowerCase()}` : wubrg(sh.colors);
        colorsRow.append(element('span', 'coach-row-sub', `Splash or 3+: ${Math.round(wideP * 100)}% (${label})`));
      }
      colorsRow.title = 'Your likely colors, from your picks and what is flowing (24spells coach)';
    }
    renderFlowRow(folded, inDraft);
    const results = grades.draftId === view?.draftId ? grades.results : [];
    const showGrade = inDraft && settings.coachGrades && results.length > 0;
    gradeRow.hidden = folded || !showGrade;
    if (showGrade) {
      const accuracy = results.reduce((a, r) => a + r.accuracy, 0) / results.length;
      const last = results[results.length - 1];
      gradeRow.textContent = '';
      gradeRow.append(element('span', 'row-cap', 'Accuracy'));
      gradeRow.append(element('span', 'coach-row-main', `${Math.round(accuracy)} · ${results.length} pick${results.length === 1 ? '' : 's'}`));
      const lastSpan = element('span', 'coach-row-sub', `Last: ${BADGE_GLYPH[last.badge]} ${last.badge}`);
      lastSpan.style.color = BADGE_COLOR[last.badge];
      gradeRow.append(lastSpan);
      gradeRow.title = 'Chess-style grades vs the coach, like the 24spells draft review';
    }
  }

  /**
   * The flow meter (0.3.8, Ken: "also add flow"): the trainer's read, one bar per color, up when more
   * good cards of that color reach you than usual at these picks, down when fewer.
   */
  function renderFlowRow(folded: boolean, inDraft: boolean): void {
    const flow = coachView?.input?.flow;
    const show = inDraft && settings.coachFlow && Boolean(flow) && Boolean(view);
    flowRow.hidden = folded || !show;
    if (!show || !flow || !view) return;
    const from = view.packNumber === 2 ? 'left' : 'right';
    flowRow.textContent = '';
    flowRow.append(element('span', 'row-cap', 'Flow'));
    const top = element('div', 'flow-top');
    const bars = element('span', 'flow-bars');
    for (const c of FLOW_ORDER) {
      const score = flow[c] ?? 0;
      const h = (Math.min(FLOW_MAX, Math.abs(score)) / FLOW_MAX) * 100;
      const col = element('span', 'flow-col');
      const up = element('span', 'flow-up');
      const down = element('span', 'flow-down');
      const fillUp = element('i');
      const fillDown = element('i');
      fillUp.style.height = `${score > 0 ? h : 0}%`;
      fillDown.style.height = `${score < 0 ? h : 0}%`;
      fillUp.style.background = FLOW_FILL[c];
      fillDown.style.background = FLOW_FILL[c];
      up.append(fillUp);
      down.append(fillDown);
      col.append(up, down, element('b', undefined, c));
      bars.append(col);
    }
    top.append(bars);
    flowRow.append(top);
    const flowing = FLOW_ORDER.filter((c) => (flow[c] ?? 0) >= 1).sort((a, b) => flow[b] - flow[a]);
    const dry = FLOW_ORDER.filter((c) => (flow[c] ?? 0) <= -1);
    const text =
      view.pickNumber <= 2
        ? 'Too early to read'
        : flowing.length
          ? `${flowing.map((c) => FLOW_NAMES[c]).join(', ')} flowing`
          : dry.length
            ? `${dry.map((c) => FLOW_NAMES[c]).join(', ')} drying up`
            : 'Nothing stands out yet';
    flowRow.append(element('span', 'coach-row-sub', `${text} · from your ${from}`));
    flowRow.classList.toggle('early', view.packNumber === 1);
    flowRow.title = FLOW_TRUST[Math.min(2, Math.max(0, view.packNumber - 1))];
  }

  /** Loads the trainer's coach for a set once, then redraws with the outlines. */
  async function loadCoach(setCode: string): Promise<void> {
    coachFor = setCode;
    coach = null;
    statline = null;
    statlineFor = setCode;
    const data = await api.getCoachData?.(setCode).catch(() => null);
    if (coachFor !== setCode) {
      return;
    }
    statline = data?.statline?.stats ? data.statline : false;
    try {
      coach = data ? createCoach(data) : null;
    } catch (error) {
      console.error('Coach failed to load', error);
      coach = null;
    }
    updateCoachTop();
    renderAll();
  }

  foldButton.addEventListener('click', () => {
    // In a draft the fold is remembered. Outside one it is a temporary peek.
    const folding = view ? !settings.folded : peek;
    if (view) {
      settings.folded = folding;
      save();
    } else {
      peek = !peek;
    }
    if (folding && panelOpen) {
      panelOpen = false;
      renderSettings();
    }
    renderStack();
  });

  mainSelect.addEventListener('change', () => {
    settings.main = mainSelect.value as MainStat;
    save();
    renderAll();
    if (panelOpen) {
      renderSettings();
    }
  });

  deckSelect.addEventListener('change', () => {
    settings.deck = deckSelect.value;
    save();
    renderAll();
  });

  renderStack();

  window.addEventListener('resize', renderPlates);
  window.addEventListener('mousemove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
    updateHover(event.clientX, event.clientY);
    updateInteractive(event.clientX, event.clientY);
  });

  api.onAccount?.((next) => {
    account = next;
    renderAll();
  });
  void api.getAccount?.().then((next) => {
    account = next;
    renderAll();
  });

  api.onToggleHidden(() => {
    hidden = !hidden;
    renderAll();
  });

  // Live mulligan info (2026-11-16): two win chances at Arena's mulligan prompt, never a verdict.
  mountMullPlate(root, api);

  api.onDraftView(async (next) => {
    view = next;
    if (next) lastView = next;
    peek = false;
    if (next) {
      // Keyed by draft too, so a new draft picks up stats refreshed in the background.
      const key = `${next.setCode}|${next.format}|${next.draftId}`;
      // Retry while empty, so stats appear as soon as a download finishes.
      if (key !== loadedFor || !loaded) {
        loaded = await api.getSetStats(next.setCode, next.format, next.cardIds);
        loadedFor = key;
      }
      const setCode = next.setCode ?? loaded?.stats.set ?? null;
      if (setCode && setCode !== coachFor) {
        void loadCoach(setCode);
      }
    }
    updateCoachTop();
    renderAll();
  });
}
