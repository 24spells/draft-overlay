// Where each card sits on Arena's draft screen. The log lists a pack in
// booster order, so the pack has to be re-sorted the way Arena displays it.

const CARDS_PER_ROW = 8; // Arena 2026-11 (TRK): 8 per row, measured on a 3200x1800 window
const RARITY_ORDER: Record<string, number> = {
  mythic: 0, rare: 1, uncommon: 2, common: 3, basic: 4,
};
const MONO_ORDER = 'WUBRG';
const PAIR_ORDER = ['WU', 'UB', 'BR', 'RG', 'WG', 'WB', 'UR', 'BG', 'WR', 'UG'];

export type SortableCard = {
  id: number;
  rarity?: string;
  color?: string;
  isLand?: boolean;
};

export type Positioned<T> = { card: T; column: number; row: number };

export type Calibration = { x: number; y: number; scale: number };
export const NO_CALIBRATION: Calibration = { x: 0, y: 0, scale: 1 };

export type Geometry = {
  left: number;
  top: number;
  stepX: number;
  stepY: number;
  cardWidth: number;
  cardHeight: number;
};

export type Rect = { left: number; top: number; width: number; height: number };

function colorRank(card: SortableCard): number {
  if (card.isLand) {
    return 7;
  }
  const color = card.color ?? '';
  if (color.length > 1) {
    return 5;
  }
  return color.length === 1 ? MONO_ORDER.indexOf(color) : 6;
}

function pairRank(card: SortableCard): number {
  const color = card.color ?? '';
  if (color.length <= 1) {
    return 0;
  }
  const rank = PAIR_ORDER.indexOf(color);
  return rank === -1 ? PAIR_ORDER.length : rank;
}

/** Sorts first, so an unknown card can never shift the cards after it. */
export function positionCards<T extends SortableCard>(
  cards: T[],
): Positioned<T>[] {
  return [...cards]
    .sort(
      (a, b) =>
        (RARITY_ORDER[a.rarity ?? ''] ?? 5) -
          (RARITY_ORDER[b.rarity ?? ''] ?? 5) ||
        colorRank(a) - colorRank(b) ||
        pairRank(a) - pairRank(b) ||
        a.id - b.id,
    )
    .map((card, index) => ({
      card,
      column: index % CARDS_PER_ROW,
      row: Math.floor(index / CARDS_PER_ROW),
    }));
}

/**
 * Grid for a given window size. 16:9 uses figures measured at 2560x1440;
 * narrower windows use figures measured at 1728x1117. Both are single-source,
 * which is why the settings include position nudges. Windows wider than 16:9
 * are unverified and treated as a centered 16:9 area.
 */
export function gridGeometry(
  width: number,
  height: number,
  calibration: Calibration = NO_CALIBRATION,
): Geometry {
  const aspect = width / height;
  let geometry: Geometry;

  if (aspect >= 1.7) {
    const boxWidth = Math.min(width, (height * 16) / 9);
    const offset = (width - boxWidth) / 2;
    geometry = {
      left: offset + 0.1746 * boxWidth,
      top: 0.1612 * height,
      stepX: 0.0829 * boxWidth,
      stepY: 0.1863 * height,
      cardWidth: 0.0722 * boxWidth,
      cardHeight: 0.1806 * height,
    };
  } else {
    const scale = Math.min(width / 1728, height / 1117);
    geometry = {
      left: (width - 1728 * scale) / 2 + 174.528 * scale,
      top: (height - 1117 * scale) / 2 + 212.7885 * scale,
      stepX: 196.992 * scale,
      stepY: 268.9736 * scale,
      cardWidth: 184.896 * scale,
      cardHeight: 261.378 * scale,
    };
  }

  return {
    left: geometry.left + (calibration.x / 100) * width,
    top: geometry.top + (calibration.y / 100) * height,
    stepX: geometry.stepX * calibration.scale,
    stepY: geometry.stepY * calibration.scale,
    cardWidth: geometry.cardWidth * calibration.scale,
    cardHeight: geometry.cardHeight * calibration.scale,
  };
}

export function cardRect(
  column: number,
  row: number,
  geometry: Geometry,
): Rect {
  return {
    left: geometry.left + column * geometry.stepX,
    top: geometry.top + row * geometry.stepY,
    width: geometry.cardWidth,
    height: geometry.cardHeight,
  };
}
