// Browser preview: replays saved drafts on a stand-in for Arena's draft screen.
// Runs the real overlay. Only this file and sim.css are preview-only.

import { cardRect, gridGeometry, positionCards } from '../core/layout.ts';
import type { AccountState, DraftView, SetStats } from '../core/types.ts';
import { mountOverlay } from '../overlay/overlay.ts';

type SimPack = DraftView & { taken: number | null };
type SimDraft = { date: string; packs: SimPack[] };

const stage = document.getElementById('stage')!;
const bar = document.getElementById('bar')!;

async function loadJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function make<K extends keyof HTMLElementTagNameMap>(
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

const SIM_SET = new URLSearchParams(location.search).get('set')?.toUpperCase() ?? null;

async function start(): Promise<void> {
  const [drafts, images, stats] = await Promise.all([
    // ?set=TRK previews another set (sim/make-set-sim.mjs builds its sample packs).
    loadJson<SimDraft[]>(SIM_SET ? `/sim-data/drafts-${SIM_SET}.json` : '/sim-data/drafts.json'),
    loadJson<Record<string, string>>(SIM_SET ? `/sim-data/images-${SIM_SET}.json` : '/sim-data/images.json'),
    loadJson<SetStats>(`/card-data/${SIM_SET ?? 'FRA'}.PremierDraft.json`),
  ]);

  let draftIndex = drafts.length - 1;
  let packIndex = 0;
  let viewCallback: (view: DraftView | null) => void = () => {};
  let hideCallback: () => void = () => {};
  let account: AccountState = { connected: new URLSearchParams(location.search).has('connected') ? 'you' : null, pairing: false };
  let accountCallback: (next: AccountState) => void = () => {};
  let mullCallback: (event: import('../core/mull-live.ts').MullEvent) => void = () => {};

  mountOverlay(document.getElementById('overlay')!, {
    onDraftView(callback) {
      viewCallback = callback;
      return () => {};
    },
    getSetStats: async () => ({ stats, note: null }),
    // The coach hint, like the real app: the web trainer's files for the set (served by sim/serve.mjs).
    getCoachData: async (setCode) => {
      const get = (name: string) => fetch(`/coach-data/${name}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const [set, flow, builds, splash] = await Promise.all([get(`${setCode}.json`), get(`${setCode}-flow.json`), get(`${setCode}-builds.json`), get(`${setCode}-splash.json`)]);
      return set ? { set, flow, builds, splash } : null;
    },
    onToggleHidden(callback) {
      hideCallback = callback;
      return () => {};
    },
    setInteractive() {},
    // The Connect button (0.3.9): ?connected=1 previews a linked PC (no button).
    getAccount: async () => account,
    onAccount(callback) {
      accountCallback = callback;
      return () => {};
    },
    connectAccount: async () => {
      account = { connected: null, pairing: true };
      accountCallback(account);
    },
    // Mulligan preview (2026-11-16): ?mull=FRA&hand=N shows a real sample hand at a stand-in mulligan screen.
    onMulligan(callback) {
      mullCallback = callback;
      return () => {};
    },
    getMullModel: (setCode) => fetch(`/mull-data/${setCode}-mull.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  });

  const MULL = new URLSearchParams(location.search).get('mull')?.toUpperCase();
  if (MULL) {
    const model = await loadJson<{ samples: { hand: number[]; deck: number[]; onPlay: boolean }[] }>(`/mull-data/${MULL}-mull.json`);
    const index = Number(new URLSearchParams(location.search).get('hand') ?? 0);
    const sample = model.samples[index % model.samples.length];
    stage.textContent = '';
    stage.append(make('div', 'sim-tag', `Simulated Arena mulligan screen. Sample hand ${index} (${MULL}, 17Lands replay data)`));
    const row = make('div', 'sim-hand');
    for (const id of sample.hand) {
      const name = stats.cards[String(id)]?.name;
      const node = make('div', 'sim-card');
      const source = name ? (images[name] ?? images[name.split(' // ')[0]]) : undefined;
      if (source) {
        const image = make('img');
        image.alt = name ?? '';
        image.src = source;
        node.append(image);
      } else {
        node.append(make('div', 'sim-tile', name ?? 'Basic land'));
      }
      row.append(node);
    }
    const buttons = make('div', 'sim-mull-buttons');
    buttons.append(make('span', 'sim-btn', 'Mulligan'), make('span', 'sim-btn keep', 'Keep 7'));
    stage.append(row, buttons);
    setTimeout(() => mullCallback({ kind: 'prompt', data: { gameId: 'sim', set: MULL, hand: sample.hand, deck: sample.deck, onPlay: sample.onPlay, prompt: 1 } }), 300);
    return;
  }

  function drawStage(pack: SimPack): void {
    stage.textContent = '';
    stage.append(make('div', 'sim-tag', `Simulated Arena screen. Pack ${pack.packNumber}, pick ${pack.pickNumber}`));

    const geometry = gridGeometry(window.innerWidth, window.innerHeight);
    const cards = pack.cardIds.map((id) => ({ id, ...stats.cards[String(id)] }));

    for (const { card, column, row } of positionCards(cards)) {
      const rect = cardRect(column, row, geometry);
      const node = make('div', card.id === pack.taken ? 'sim-card taken' : 'sim-card');
      node.style.left = `${rect.left}px`;
      node.style.top = `${rect.top}px`;
      node.style.width = `${rect.width}px`;
      node.style.height = `${rect.height}px`;

      const showTile = (): void => {
        node.textContent = '';
        const tile = make('div', 'sim-tile');
        tile.append(
          make('span', undefined, card.name ?? `Unknown card ${card.id}`),
          make('small', undefined, `${card.rarity ?? ''} ${card.color ?? ''}`),
        );
        node.append(tile);
      };

      const source = card.name
        ? (images[card.name] ?? images[card.name.split(' // ')[0]])
        : undefined;
      if (source) {
        const image = make('img');
        image.alt = card.name ?? '';
        image.src = source;
        image.addEventListener('error', showTile);
        node.append(image);
      } else {
        showTile();
      }
      stage.append(node);
    }

    const pool = make('aside', 'sim-pool');
    pool.append(make('h2', undefined, `Your picks (${pack.pickedCardIds.length})`));
    const list = make('ul');
    for (const id of pack.pickedCardIds) {
      list.append(make('li', undefined, stats.cards[String(id)]?.name ?? String(id)));
    }
    pool.append(list);
    stage.append(pool);
  }

  const draftSelect = make('select');
  drafts.forEach((draft, index) => {
    const option = make('option', undefined, `Your draft, ${draft.date}`);
    option.value = String(index);
    draftSelect.append(option);
  });
  draftSelect.value = String(draftIndex);

  const previous = make('button', undefined, 'Previous');
  const position = make('span', 'position');
  const next = make('button', undefined, 'Next');
  bar.append(
    draftSelect,
    previous,
    position,
    next,
    make('span', 'hint', 'Arrow keys step. H hides. Gold outline is what you took.'),
  );

  function show(): void {
    const packs = drafts[draftIndex].packs;
    const pack = packs[packIndex];
    position.textContent = `P${pack.packNumber}P${pack.pickNumber} (${packIndex + 1} of ${packs.length})`;
    drawStage(pack);
    viewCallback(pack);
  }

  function step(delta: number): void {
    const count = drafts[draftIndex].packs.length;
    packIndex = Math.max(0, Math.min(count - 1, packIndex + delta));
    show();
  }

  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  draftSelect.addEventListener('change', () => {
    draftIndex = Number(draftSelect.value);
    packIndex = 0;
    show();
  });

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLSelectElement) {
      return;
    }
    if (event.key === 'ArrowRight') step(1);
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key.toLowerCase() === 'h') hideCallback();
  });
  window.addEventListener('resize', () => drawStage(drafts[draftIndex].packs[packIndex]));

  const start = new URLSearchParams(location.search).get('pack');
  if (start) {
    packIndex = Math.max(0, Math.min(drafts[draftIndex].packs.length - 1, Number(start)));
  }
  show();

  // Lets a screenshot show the settings panel or the hover panel.
  const params = new URLSearchParams(location.search);
  if (params.has('nodraft')) {
    stage.textContent = '';
    viewCallback(null);
  }
  setTimeout(() => {
    if (params.has('settings')) {
      document.querySelector<HTMLElement>('.settings-button')?.click();
    }
    if (params.has('statsoff')) {
      document.querySelector<HTMLElement>('.stats-toggle')?.click();
    }
    if (params.has('folded')) {
      document.querySelector<HTMLElement>('.fold-button')?.click();
    }
    const hover = params.get('hover');
    if (hover) {
      const rect = cardRect(
        Number(hover) % 5,
        Math.floor(Number(hover) / 5),
        gridGeometry(window.innerWidth, window.innerHeight),
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    }
  }, 1500);
}

start().catch((error: unknown) => {
  const box = make('div', 'sim-error', `The preview could not load: ${String(error)}`);
  document.body.append(box);
});
