// Reads draft events from Arena's Player.log. JSON helpers adapted from
// 17-buddy (MIT, see LICENSE).

import type { DraftFormat, DraftView } from './types.ts';

type JsonObject = Record<string, unknown>;

export type LogEvent =
  | { type: 'joined'; setCode: string; format: DraftFormat }
  | {
      type: 'pack';
      format: DraftFormat | null;
      draftId: string | null;
      setCode: string | null;
      packNumber: number;
      pickNumber: number;
      cardIds: number[];
      pickedCardIds: number[] | null;
    }
  | { type: 'pick'; cardIds: number[] }
  | { type: 'over' };

const EVENT_NAME = /(PremierDraft|QuickDraft|TraditionalDraft)_([A-Za-z0-9]+)_\d{8}/;
const NOTIFY_MARKER = 'Draft.Notify';
const PICK_MARKERS = [
  '==> EventPlayerDraftMakePick',
  '==> Event_PlayerDraftMakePick',
  '==> BotDraftDraftPick',
  '==> BotDraft_DraftPick',
];
const START_MARKERS = [
  '==> EventJoin',
  '==> Event_Join',
  '==> BotDraftDraftStatus',
  '==> BotDraft_DraftStatus',
];

export function parseLogLine(line: string): LogEvent | null {
  return (
    parsePremierPack(line) ??
    parsePick(line) ??
    parseJoined(line) ??
    parseQuickPack(line)
  );
}

function parsePremierPack(line: string): LogEvent | null {
  const index = line.indexOf(NOTIFY_MARKER);
  if (index === -1) {
    return null;
  }

  const message = parseJsonObjectFrom(line, index + NOTIFY_MARKER.length);
  const packNumber = parseInteger(message?.SelfPack);
  const pickNumber = parseInteger(message?.SelfPick);
  const packCards = message?.PackCards;
  if (
    packNumber === null ||
    pickNumber === null ||
    typeof packCards !== 'string' ||
    packCards.length === 0
  ) {
    return null;
  }

  const cardIds = parseCardIds(packCards.split(','));
  if (cardIds === null) {
    return null;
  }

  return {
    type: 'pack',
    format: null,
    draftId: typeof message?.draftId === 'string' ? message.draftId : null,
    setCode: null,
    packNumber,
    pickNumber,
    cardIds,
    pickedCardIds: null,
  };
}

function parsePick(line: string): LogEvent | null {
  const marker = PICK_MARKERS.find((candidate) => line.includes(candidate));
  if (!marker) {
    return null;
  }

  const message = parseJsonObjectFrom(
    line,
    line.indexOf(marker) + marker.length,
  );
  const request = parseJsonObject(message?.request);
  return { type: 'pick', cardIds: parseCardIds(request?.GrpIds) ?? [] };
}

function parseJoined(line: string): LogEvent | null {
  const isStart = START_MARKERS.some((marker) => line.includes(marker));
  const isCourse =
    line.includes('{"Course":{') && line.includes('"CurrentModule":"PlayerDraft"');
  if (!isStart && !isCourse) {
    return null;
  }

  const match = line.match(EVENT_NAME);
  return match
    ? {
        type: 'joined',
        format: match[1] as DraftFormat,
        setCode: match[2].toUpperCase(),
      }
    : null;
}

function parseQuickPack(line: string): LogEvent | null {
  const markerIndex = line.indexOf('"CurrentModule"');
  if (markerIndex === -1) {
    return null;
  }

  const message = parseJsonObjectFrom(line, line.lastIndexOf('{', markerIndex));
  if (message?.CurrentModule !== 'BotDraft') {
    return null;
  }

  const payload = parseJsonObject(message.Payload);
  if (!payload) {
    return null;
  }
  if (payload.DraftStatus !== 'PickNext') {
    return typeof payload.DraftStatus === 'string' ? { type: 'over' } : null;
  }

  const eventName =
    typeof payload.EventName === 'string'
      ? payload.EventName.match(EVENT_NAME)
      : null;
  const packNumber = parseInteger(payload.PackNumber);
  const pickNumber = parseInteger(payload.PickNumber);
  const cardIds = parseCardIds(payload.DraftPack);
  const pickedCardIds = parseCardIds(payload.PickedCards);
  if (
    !eventName ||
    packNumber === null ||
    pickNumber === null ||
    cardIds === null ||
    pickedCardIds === null
  ) {
    return null;
  }

  return {
    type: 'pack',
    format: eventName[1] as DraftFormat,
    draftId: null,
    setCode: eventName[2].toUpperCase(),
    packNumber: packNumber + 1,
    pickNumber: pickNumber + 1,
    cardIds,
    pickedCardIds,
  };
}

/**
 * Turns log events into what should be on screen. A pick clears the pack
 * until the next one arrives, so the overlay also disappears after the last
 * pick, for which Arena writes no end-of-draft message.
 */
export class DraftTracker {
  view: DraftView | null = null;
  private setCode: string | null = null;
  private format: DraftFormat | null = null;
  private draftId: string | null = null;
  private picks: number[] = [];

  /** Returns true if what should be on screen changed. */
  apply(event: LogEvent): boolean {
    switch (event.type) {
      case 'joined':
        this.setCode = event.setCode;
        this.format = event.format;
        return false;
      case 'pack': {
        if (
          (event.packNumber === 1 && event.pickNumber === 1) ||
          (event.draftId !== null && event.draftId !== this.draftId)
        ) {
          this.picks = [];
        }
        this.draftId = event.draftId ?? this.draftId;
        this.view = {
          setCode: event.setCode ?? this.setCode,
          format: event.format ?? this.format ?? 'PremierDraft',
          draftId: this.draftId,
          packNumber: event.packNumber,
          pickNumber: event.pickNumber,
          cardIds: event.cardIds,
          pickedCardIds: event.pickedCardIds ?? [...this.picks],
        };
        return true;
      }
      case 'pick': {
        const changed = this.view !== null;
        if (changed) {
          this.picks.push(...event.cardIds);
        }
        this.view = null;
        return changed;
      }
      case 'over': {
        const changed = this.view !== null;
        this.view = null;
        this.picks = [];
        return changed;
      }
    }
  }
}

function parseCardIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = value.map(parseInteger);
  return ids.every((id) => id !== null) ? (ids as number[]) : null;
}

function parseInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(value: unknown): JsonObject | null {
  if (isJsonObject(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObjectFrom(line: string, from: number): JsonObject | null {
  const start = line.indexOf('{', from);
  if (start === -1) {
    return null;
  }
  const json = extractJsonObject(line, start);
  return json ? parseJsonObject(json) : null;
}

function extractJsonObject(line: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return line.slice(start, index + 1);
      }
    }
  }
  return null;
}
