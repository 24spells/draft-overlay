// The on-screen overlay. Plain DOM with no framework, so the same code runs
// in the browser preview and in the real app.

import { coachRanks, createCoach, PackMemory, type Coach } from './coach-hint.ts';
import { gradeScore } from '../core/grades.ts';
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
  CardMeta,
  DraftView,
  LoadedStats,
  OverlayApi,
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
  /** The Coach ON/OFF button: outline the coach's top picks, like the 23spells hint. On by default. */
  coachHint: boolean;
  /** Ranked shows 1, 2, 3 on the outlined cards; outline only is the trainer's unranked hint (your call). */
  coachStyle: 'ranked' | 'outline';
  /** How many top picks to mark. */
  coachCount: number;
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
};

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
  let loaded: LoadedStats | null = null;
  let loadedFor = '';
  let hidden = false;
  let placed: Placed[] = [];
  let hovered: Placed | null = null;
  let panelOpen = false;
  /** Outside a draft the stack shows as a folded tab until clicked open. */
  let peek = false;
  let interactive = false;
  let mouseX = -1;
  let mouseY = -1;
  let averages: Record<MetricId, number | null> | null = null;
  /** The web trainer's coach for the set in front of you (null until loaded, or if the site has no such set). */
  let coach: Coach | null = null;
  let coachFor = '';
  /** Arena card id -> the coach's rank for it (1 = best), for the pack on screen. */
  let coachTop = new Map<number, number>();
  const packMemory = new PackMemory();

  root.classList.add('draft-overlay');
  const plates = element('div', 'plates');
  const hoverPanel = element('aside', 'hover-panel');
  const controls = element('div', 'controls');
  const stack = element('div', 'toggle-stack');
  const setInfo = element('div', 'stack-row stack-info');
  const statsButton = element('button', 'stack-row stack-button stats-toggle');
  const coachButton = element('button', 'stack-row stack-button stats-toggle coach-toggle');
  coachButton.title = "Outline the coach's top 3 picks, the same hint as on 23spells";
  const mainLabel = element('label', 'stack-row stack-select');
  const mainSelect = element('select');
  const deckLabel = element('label', 'stack-row stack-select');
  const deckSelect = element('select');
  const settingsButton = element('button', 'stack-row stack-button settings-button', 'Settings');
  const foldButton = element('button', 'stack-row stack-button fold-button');
  for (const button of [statsButton, coachButton, settingsButton, foldButton]) {
    button.type = 'button';
  }
  const panel = element('section', 'settings-panel');
  const status = element('p', 'status');
  const credit = element('p', 'credit');

  mainLabel.append(element('span', 'stack-label', 'Show'), wrapSelect(mainSelect));
  deckLabel.append(element('span', 'stack-label', 'Compare'), wrapSelect(deckSelect));
  stack.append(setInfo, statsButton, coachButton, mainLabel, deckLabel, settingsButton, foldButton);
  controls.append(stack, panel, status, credit);
  root.append(plates, hoverPanel, controls);

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
    const plate = element('div', `plate ${gradeClass(entry.row)}`);
    plate.style.left = `${entry.rect.left + entry.rect.width * 0.05}px`;
    plate.style.top = `${entry.rect.top + entry.rect.height * 0.13}px`;
    plate.style.width = `${entry.rect.width * 0.9}px`;
    plate.style.setProperty('--u', `${scale}px`);
    if (entry.row?.lowSample && settings.lowSample === 'dim') {
      plate.classList.add('low-sample');
    }

    const main = mainDisplay(entry.row);
    const mainCell = element('div', main.wide ? 'main wide' : 'main', main.text);
    plate.append(mainCell);

    const smalls = settings.small.filter(
      (metric): metric is MetricId => metric !== 'none',
    );
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
    hovered = null;
    hoverPanel.classList.remove('visible');

    const outlines = settings.coachHint && coachTop.size > 0;
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
    const geometry = gridGeometry(
      window.innerWidth,
      window.innerHeight,
      settings.calibration,
    );
    const cards = view.cardIds.map((id) => ({
      id,
      meta: set.cards[String(id)],
      rarity: set.cards[String(id)]?.rarity,
      color: set.cards[String(id)]?.color,
      isLand: set.cards[String(id)]?.isLand,
    }));

    for (const { card, column, row } of positionCards(cards)) {
      const rect = cardRect(column, row, geometry);
      if (outlines && coachTop.has(card.id)) {
        // The coach's top picks: outlined (the trainer's hint look), ranked if chosen.
        const rank = coachTop.get(card.id)!;
        const ring = element('div', `coach-outline${rank === 1 && settings.coachStyle === 'ranked' ? ' first' : ''}`);
        if (settings.coachStyle === 'ranked') {
          ring.append(element('span', 'coach-rank', String(rank)));
        }
        ring.style.left = `${rect.left}px`;
        ring.style.top = `${rect.top}px`;
        ring.style.width = `${rect.width}px`;
        ring.style.height = `${rect.height}px`;
        ring.style.setProperty('--u', `${rect.width / 185}px`);
        plates.append(ring);
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
        ? ` Coach's top ${settings.coachCount} ${settings.coachStyle === 'ranked' ? 'ranked' : 'outlined'} (23spells coach).`
        : ' Coach hint: no 23spells data for this set yet.';
    }
  }

  function renderHover(): void {
    for (const entry of placed) {
      const near =
        hovered !== null &&
        Math.abs(entry.column - hovered.column) <= 1 &&
        Math.abs(entry.rowIndex - hovered.rowIndex) <= 1;
      entry.plate.classList.toggle('covered', near);
    }

    hoverPanel.textContent = '';
    hoverPanel.classList.toggle('visible', hovered !== null);
    if (!hovered) {
      return;
    }

    const row = hovered.row;
    const head = element('header', 'hover-head');
    head.append(
      element('h3', undefined, hovered.meta?.name ?? 'Unknown card'),
      element('strong', `hover-grade ${gradeClass(row)}`, row?.grade ?? '-'),
    );
    hoverPanel.append(head);

    const table = element('table', 'hover-table');
    const headRow = element('tr');
    headRow.append(
      element('th'),
      element('th', undefined, 'Win rate'),
      element('th', undefined, 'vs average card'),
    );
    const thead = element('thead');
    thead.append(headRow);
    const tbody = element('tbody');
    const winRates: MetricId[] = ['gih', 'oh', 'gd', 'gp', 'gns'];
    for (const metric of winRates) {
      const value = row?.values[metric] ?? null;
      const average = averages?.[metric] ?? null;
      const difference = value !== null && average !== null ? value - average : null;
      const tr = element('tr');
      tr.append(
        element('td', undefined, METRICS[metric].name),
        element('td', 'value', formatMetric(metric, value)),
        element(
          'td',
          difference === null || Math.abs(difference) < 0.05
            ? 'difference'
            : `difference ${difference > 0 ? 'up' : 'down'}`,
          difference === null ? '-' : `${difference >= 0 ? '+' : ''}${difference.toFixed(1)}`,
        ),
      );
      tbody.append(tr);
    }
    table.append(thead, tbody);
    hoverPanel.append(table);

    const tiles = element('div', 'hover-tiles');
    const tileMetrics: MetricId[] = ['iwd', 'games', 'ata', 'alsa'];
    for (const metric of tileMetrics) {
      const tile = element('div', 'hover-tile');
      tile.append(
        element('span', 'tile-value', row ? formatMetric(metric, row.values[metric]) : '-'),
        element('span', 'tile-label', METRICS[metric].name),
      );
      tiles.append(tile);
    }
    hoverPanel.append(tiles);
    if (row?.lowSample) {
      hoverPanel.append(
        element('p', 'hover-note', `Fewer than ${settings.minGames} games in hand, so no grade.`),
      );
    }
    if (settings.coachHint && coachTop.has(hovered.id)) {
      hoverPanel.append(
        element(
          'p',
          'hover-coach',
          settings.coachStyle === 'ranked'
            ? `The coach's #${coachTop.get(hovered.id)} pick here.`
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
    foldButton.textContent = folded ? '▲ Overlay' : '▼ Close';
    foldButton.title = folded ? 'Open the overlay controls' : 'Fold the overlay controls';

    setInfo.textContent = view
      ? `${view.setCode ?? loaded?.stats.set ?? '?'} · ${FORMAT_NAMES[view.format] ?? 'Draft'}`
      : 'No draft open';

    statsButton.textContent = `Stats: ${settings.showStats ? 'ON' : 'OFF'}`;
    statsButton.classList.toggle('on', settings.showStats);
    coachButton.textContent = `Coach: ${settings.coachHint ? 'ON' : 'OFF'}`;
    coachButton.classList.toggle('on', settings.coachHint);
    mainSelect.value = settings.main;
    deckSelect.value = settings.deck;
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
      settingRow('Picks marked', segmented(settings.coachStyle, [['ranked', 'Ranked 1-2-3'], ['outline', 'Outline only']], (value) => {
        settings.coachStyle = value as Settings['coachStyle'];
      }), "Outline only is the trainer's hint: the top picks in no order, your call"),
      settingRow('How many', segmented(String(settings.coachCount), [['1', '1'], ['3', '3'], ['5', '5']], (value) => {
        settings.coachCount = Number(value);
        updateCoachTop();
      })),
    ]);

    panel.append(head, preview, onCard, coachSection, grades, lineUp);
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
    if (!coach || !view || !loaded) {
      return;
    }
    try {
      coachTop = coachRanks(coach, view, (id) => loaded?.stats.cards[String(id)]?.name, packMemory, settings.coachCount);
    } catch (error) {
      console.error('Coach hint failed', error);
    }
  }

  /** Loads the trainer's coach for a set once, then redraws with the outlines. */
  async function loadCoach(setCode: string): Promise<void> {
    coachFor = setCode;
    coach = null;
    const data = await api.getCoachData?.(setCode).catch(() => null);
    if (coachFor !== setCode) {
      return;
    }
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

  api.onToggleHidden(() => {
    hidden = !hidden;
    renderAll();
  });

  api.onDraftView(async (next) => {
    view = next;
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
