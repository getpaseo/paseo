import type { ItemTimesPreferences } from "@/hooks/use-settings";
import type { StreamItem } from "@/types/stream";

/**
 * When a chat row finished, and how long its step took. A row's timestamp moves to its last
 * update, so it marks the end of that row; the step is the time from the end of the row before it.
 */
export interface ItemTime {
  at: Date;
  /** Null for the first row, for the user's own messages, and when two times are out of order. */
  tookMs: number | null;
}

export type ItemTimeKind = "assistant" | "toolCalls" | "thinking" | "user";

export function itemTimeKind(item: StreamItem): ItemTimeKind | null {
  switch (item.kind) {
    case "assistant_message":
      return "assistant";
    case "tool_call":
      return "toolCalls";
    case "thought":
      return "thinking";
    case "user_message":
      return "user";
    default:
      return null;
  }
}

export function showsItemTime(preferences: ItemTimesPreferences, kind: ItemTimeKind): boolean {
  return preferences.enabled && preferences[kind];
}

/** Where the walk over the rows stands, so the live rows continue from the end of history. */
export interface ItemTimeCursor {
  readonly previousAt: Date | null;
  /** The message the previous row belongs to when it was assistant text, and where it started. */
  readonly assistant: { readonly messageId: string; readonly from: Date | null } | null;
}

export const START_ITEM_TIME_CURSOR: ItemTimeCursor = { previousAt: null, assistant: null };

function validTime(value: Date | undefined): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function elapsed(from: Date | null, to: Date): number | null {
  if (!from) return null;
  const ms = to.getTime() - from.getTime();
  return ms >= 0 ? ms : null;
}

/** Times every row of `items`, in order, starting where `start` left off. */
export function timeItems(
  items: readonly StreamItem[],
  start: ItemTimeCursor,
  out: Map<string, ItemTime>,
): ItemTimeCursor {
  let cursor = start;
  for (const item of items) {
    const at = validTime(item.timestamp);
    if (!at) continue;
    if (item.kind === "assistant_message") {
      // Pieces of one message in a row are one step, timed from before the first piece.
      const continues =
        item.messageId !== undefined && cursor.assistant?.messageId === item.messageId;
      const from = continues ? cursor.assistant!.from : cursor.previousAt;
      out.set(item.id, { at, tookMs: elapsed(from, at) });
      cursor = {
        previousAt: at,
        assistant: item.messageId === undefined ? null : { messageId: item.messageId, from },
      };
      continue;
    }
    out.set(item.id, {
      at,
      tookMs: item.kind === "user_message" ? null : elapsed(cursor.previousAt, at),
    });
    cursor = { previousAt: at, assistant: null };
  }
  return cursor;
}

export interface TimedHistory {
  times: ReadonlyMap<string, ItemTime>;
  end: ItemTimeCursor;
}

const historyCache = new WeakMap<readonly StreamItem[], TimedHistory>();

/**
 * Times the retained history once per history array. A streamed delta changes only the live rows,
 * so the history map, and every history row that reads it, stays the same while a reply streams.
 */
export function timeHistory(history: readonly StreamItem[]): TimedHistory {
  const cached = historyCache.get(history);
  if (cached) return cached;
  const times = new Map<string, ItemTime>();
  const end = timeItems(history, START_ITEM_TIME_CURSOR, times);
  const timed = { times, end };
  historyCache.set(history, timed);
  return timed;
}

/** The time a grouped run of tool calls shows: its last call's end, timed from before its first. */
export function groupItemTime(
  calls: readonly StreamItem[],
  times: (itemId: string) => ItemTime | undefined,
): ItemTime | undefined {
  const first = calls[0] ? times(calls[0].id) : undefined;
  const last = calls.length ? times(calls[calls.length - 1]!.id) : undefined;
  if (!first || !last) return last ?? first;
  if (first.tookMs === null) return { at: last.at, tookMs: null };
  const start = first.at.getTime() - first.tookMs;
  const tookMs = last.at.getTime() - start;
  return { at: last.at, tookMs: tookMs >= 0 ? tookMs : null };
}

/** True when the row below continues the same assistant message, so this row shows no time. */
export function continuesAssistantMessage(item: StreamItem, below: StreamItem | null): boolean {
  return (
    item.kind === "assistant_message" &&
    below?.kind === "assistant_message" &&
    item.messageId !== undefined &&
    below.messageId === item.messageId
  );
}

/** Gap between a time line placed in the margin and the item beside it. */
export const ITEM_TIME_SIDE_GAP = 16;
/**
 * How far tool and thinking cards reach left of the column edge (their badge container has
 * `marginHorizontal: -13` in components/message.tsx), so a left-margin time line clears them.
 */
export const ITEM_TIME_CARD_BLEED = 13;
/** Room left free at the pane's left edge for the chat outline rail (8 px inset + 36 px rail). */
const SIDE_RAIL_CLEARANCE = 48;
/** Room the scroll bar can take from the pane, which shifts the centred column left by half. */
const SIDE_SCROLLBAR_ALLOWANCE = 8;
/** The narrowest margin label: "8:04:27 PM · took 4s" fits on one line; longer ones wrap upward. */
const SIDE_MIN_WIDTH = 144;
const SIDE_MAX_WIDTH = 240;
const SIDE_WIDTH_STEP = 16;

/**
 * The width of the margin label for a chat pane, or null when the margin beside the centred
 * column is too narrow for one (or the column uses the uncapped Full width preset). Stepped, so a
 * window resize changes it only every few pixels.
 */
export function resolveItemTimeSideWidth(input: {
  paneWidth: number;
  contentMaxWidth: number | undefined;
  listPaddingHorizontal: number;
  columnPaddingHorizontal: number;
  outlineInset?: number;
}): number | null {
  if (input.contentMaxWidth === undefined) return null;
  const outlineInset = input.outlineInset ?? 0;
  const paddingLeft = input.listPaddingHorizontal + outlineInset;
  const paddingRight =
    outlineInset > 0
      ? Math.max(
          input.listPaddingHorizontal,
          Math.min(paddingLeft, input.paneWidth - paddingLeft - input.contentMaxWidth),
        )
      : input.listPaddingHorizontal;
  const inner = input.paneWidth - paddingLeft - paddingRight;
  if (inner <= 0) return null;
  const column = Math.min(input.contentMaxWidth, inner);
  const columnContentLeft = paddingLeft + (inner - column) / 2 + input.columnPaddingHorizontal;
  const columnContentRight = paddingRight + (inner - column) / 2 + input.columnPaddingHorizontal;
  const leftRoom =
    columnContentLeft -
    ITEM_TIME_CARD_BLEED -
    ITEM_TIME_SIDE_GAP -
    SIDE_RAIL_CLEARANCE -
    SIDE_SCROLLBAR_ALLOWANCE;
  const rightRoom = columnContentRight - ITEM_TIME_SIDE_GAP - SIDE_SCROLLBAR_ALLOWANCE;
  const room = Math.min(leftRoom, rightRoom);
  const width = Math.min(SIDE_MAX_WIDTH, Math.floor(room / SIDE_WIDTH_STEP) * SIDE_WIDTH_STEP);
  return width >= SIDE_MIN_WIDTH ? width : null;
}
