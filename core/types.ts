export type DraftFormat = 'PremierDraft' | 'QuickDraft' | 'TraditionalDraft';

export type CardMeta = {
  /** Index into SetStats.names, or -1 for cards with no stats (basics). */
  n: number;
  name: string;
  rarity: string;
  color: string;
  manaValue: number;
  isLand: boolean;
};

/** Copy-weighted [games, wins] pairs: OH, GD, GIH, GP, GNS. */
export type Block = number[];

export type PickStat = [ata: number, taken: number, alsa: number, seen: number];

export type StatGroup = {
  games: number;
  wins: number;
  blocks: (Block | 0)[];
};

export type SetStats = {
  set: string;
  format: string;
  source: {
    games: number;
    drafts: number;
    firstGame: string;
    lastGame: string;
    fileDate: string | null;
    /** Built from the 17Lands website before public files exist: limited, labeled, refreshed daily. */
    early?: boolean;
  };
  names: string[];
  cards: Record<string, CardMeta>;
  /** Keyed "<deck>|<players>", for example "ALL|all" or "UB|top". */
  groups: Record<string, StatGroup>;
  /** Keyed by players group. */
  picks: Record<string, (PickStat | 0)[]>;
};

export type DraftView = {
  setCode: string | null;
  format: DraftFormat;
  draftId: string | null;
  packNumber: number;
  pickNumber: number;
  cardIds: number[];
  pickedCardIds: number[];
};

export type LoadedStats = { stats: SetStats; note: string | null };

/**
 * The web trainer's files for one set (from the 24spells site), for the coach
 * hint: the set file (cards with text, plus stats), the flow baseline, and
 * the measured deck-shape prices, and what is worth splashing per color pair.
 * Flow, prices and splash data may be missing (new sets).
 */
export type CoachData = { set: unknown; flow: unknown | null; builds: unknown | null; splash?: unknown | null };

/** Everything the overlay needs from its host: the real app or the preview. */
export type OverlayApi = {
  onDraftView: (callback: (view: DraftView | null) => void) => () => void;
  getSetStats: (
    setCode: string | null,
    format: DraftFormat,
    cardIds: number[],
  ) => Promise<LoadedStats | null>;
  onToggleHidden: (callback: () => void) => () => void;
  setInteractive: (interactive: boolean) => void;
  /** The trainer's coach files for a set, or null (offline, or no such set on the site). */
  getCoachData?: (setCode: string) => Promise<CoachData | null>;
  /** The current draft from Arena's log: each pick's pack and the card taken (Review in 24spells). */
  getReview?: () => Promise<ReviewData | null>;
  /** Opens a 24spells link in the browser (only that site). */
  openReview?: (url: string) => Promise<boolean>;
  /** The newest recorded Arena run, when the overlay is connected to 24spells (its records survive Arena's log resets). */
  getLatestRun?: () => Promise<{ set: string | null; course: string; at?: number | null } | null>;
  /** The newest sealed pool in Arena's logs, as a 24spells link (2026-11-14). */
  getSealedPool?: () => Promise<{ set: string; event: string; at: number | null; cards: number; unknown: number; url: string } | null>;
};

export type ReviewData = {
  setCode: string | null;
  format: DraftFormat | null;
  picks: { pack: number; pick: number; cards: number[]; taken: number | null }[];
};
