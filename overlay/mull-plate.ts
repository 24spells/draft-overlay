// The mulligan plate (Ken 2026-11-16): at Arena's mulligan prompt, two numbers and nothing else to decide for you.
//   Expected win rate this game: If you keep this hand 54%   ·   If you mulligan 44%
// Information, never a decision: no Keep/Ship word, no good/bad colors. First seven only (what the model reads).
// Off with the "Mulligan info" setting (localStorage overlay.mullInfo = "off").

import { mullRead, type MullModel, type MullRead } from '../core/mulligan.ts';
import type { MullEvent } from '../core/mull-live.ts';
import type { OverlayApi } from '../core/types.ts';

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function mountMullPlate(root: HTMLElement, api: OverlayApi): void {
  if (!api.onMulligan || !api.getMullModel) return;
  const plate = document.createElement('div');
  plate.className = 'mull-plate';
  plate.hidden = true;
  root.append(plate);
  const models = new Map<string, Promise<MullModel | null>>();
  let token = 0;

  const off = () => {
    try {
      return localStorage.getItem('overlay.mullInfo') === 'off';
    } catch {
      return false;
    }
  };

  function render(read: MullRead, set: string, onPlay: boolean, model: MullModel): void {
    plate.replaceChildren();
    const head = document.createElement('div');
    head.className = 'mull-head';
    const title = document.createElement('div');
    title.className = 'mull-title';
    title.textContent = 'Expected win rate this game';
    const meta = document.createElement('div');
    meta.className = 'mull-meta';
    meta.textContent = `${onPlay ? 'On the play' : 'On the draw'} · ${read.lands} land${read.lands === 1 ? '' : 's'} in hand`;
    head.append(title, meta);
    const nums = document.createElement('div');
    nums.className = 'mull-nums';
    const cell = (label: string, value: string, sub?: string) => {
      const c = document.createElement('div');
      c.className = 'mull-cell';
      const b = document.createElement('b');
      b.textContent = value;
      const s = document.createElement('span');
      s.textContent = label;
      c.append(b, s);
      if (sub) {
        const small = document.createElement('small');
        small.textContent = sub;
        c.append(small);
      }
      return c;
    };
    nums.append(
      read.keep === null
        ? cell('If you keep this hand', '-', `Too few kept ${read.lands}-land hands to estimate`)
        : cell('If you keep this hand', pct(read.keep), 'these seven cards'),
      cell('If you mulligan', pct(read.ship), 'whatever hand you keep next'),
    );
    const foot = document.createElement('div');
    foot.className = 'mull-foot';
    const who = document.createElement('div');
    who.textContent = model.kind === 'pooled' ? 'Chance to win for a typical 17Lands player.' : 'Chance to win for a typical 17Lands player with this deck.';
    const src = document.createElement('div');
    src.textContent =
      model.kind === 'pooled'
        ? `No ${set} card data yet: general model (lands, curve, colors).`
        : `${set} · checked on games it never saw.${read.unknown ? ` ${read.unknown} card${read.unknown === 1 ? '' : 's'} not in the data.` : ''}`;
    foot.append(who, src);
    plate.append(head, nums, foot);
    plate.hidden = false;
  }

  api.onMulligan((e: MullEvent) => {
    const mine = ++token;
    if (e.kind === 'clear' || off() || e.data.prompt !== 1 || !e.data.set || e.data.hand.length !== 7) {
      plate.hidden = true;
      return;
    }
    const { set, hand, deck, onPlay } = e.data;
    if (!models.has(set)) models.set(set, api.getMullModel!(set));
    void models.get(set)!.then((model) => {
      if (mine !== token) return;
      if (!model) {
        models.delete(set); // try again next game (offline, or not published yet)
        plate.hidden = true;
        return;
      }
      render(mullRead(model, hand, deck, onPlay, undefined, e.data.basics ?? {}), set, onPlay, model);
    });
  });
}
