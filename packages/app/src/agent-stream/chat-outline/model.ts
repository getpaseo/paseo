import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import type { StreamItem } from "@/types/stream";

export type ChatOutlinePrompt = AgentTimelinePromptIndexPayload["prompts"][number];

export function shouldAcceptPromptIndexEpoch(timelineEpoch: string, indexEpoch: string): boolean {
  return timelineEpoch === indexEpoch;
}

/**
 * Slots further than this from the pointer keep their resting size, so a long rail
 * magnifies a local band instead of swelling the whole column.
 */
export const OUTLINE_MAGNIFY_RADIUS = 3;

/**
 * Dock-style falloff: 1 under the pointer, easing to 0 at the radius. The raised cosine
 * has no corner at either end, so sweeping the rail reads as one bulge travelling with
 * the pointer rather than a band switching on and off.
 */
export function promptTickMagnification(slotDistance: number): number {
  const distance = Math.abs(slotDistance);
  if (!Number.isFinite(distance) || distance >= OUTLINE_MAGNIFY_RADIUS) {
    return 0;
  }
  return (1 + Math.cos((Math.PI * distance) / OUTLINE_MAGNIFY_RADIUS)) / 2;
}

/**
 * The slot under a touch on a rail whose slots tile its height in prompt order. A finger
 * that slides past either end keeps the end slot, so scrubbing to the first or last prompt
 * does not demand a precise stop. Runs on the UI thread from the native scrubber.
 */
export interface PromptSlotInput {
  offsetY: number;
  railHeight: number;
  slotCount: number;
}

export function resolvePromptSlotAt({
  offsetY,
  railHeight,
  slotCount,
}: PromptSlotInput): number | null {
  "worklet";
  if (!(railHeight > 0) || slotCount < 1 || !Number.isFinite(offsetY)) {
    return null;
  }
  const slot = Math.floor((offsetY / railHeight) * slotCount);
  return Math.min(slotCount - 1, Math.max(0, slot));
}

/**
 * Vertical travel past this, while it still beats horizontal travel, is the line at which
 * the left-drawer gesture gives up (`mobile-panels/gesture-intent.ts`). The scrub takes
 * the touch on that same line.
 */
const OUTLINE_SCRUB_VERTICAL_ACTIVATION = 10;

/**
 * Sideways travel that should release the touch while the drawer can still claim it. The
 * drawer itself activates at 15, so failing here happens first.
 */
const OUTLINE_SCRUB_HORIZONTAL_FAIL = 10;

export type OutlineScrubIntent = "activate" | "fail" | "wait";

/**
 * Whether a finger on the outline strip should scrub, or should get out of the way of the
 * left-drawer swipe. Vertical dominance wins even when one sample jumps past both axes, so
 * a flick still scrubs; a tie or a sideways move fails the scrub first.
 */
export function resolveOutlineScrubIntent(dx: number, dy: number): OutlineScrubIntent {
  "worklet";
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return "fail";
  }
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absY > OUTLINE_SCRUB_VERTICAL_ACTIVATION && absY > absX) {
    return "activate";
  }
  if (absX >= OUTLINE_SCRUB_HORIZONTAL_FAIL && absX >= absY) {
    return "fail";
  }
  return "wait";
}

export interface OutlinePreviewPlacement {
  railY: number;
  columnY: number;
  columnHeight: number;
  slotIndex: number;
  slotCount: number;
  previewHeight: number;
  fingerClearance: number;
}

/**
 * Top of the preview bubble in the stream container: above the slot under the finger, and
 * never above the container itself when the first slots leave no room.
 */
export function resolveOutlinePreviewTop(placement: OutlinePreviewPlacement): number | null {
  const { railY, columnY, columnHeight, slotIndex, slotCount, previewHeight, fingerClearance } =
    placement;
  if (slotCount < 1 || !(columnHeight > 0) || !Number.isFinite(slotIndex)) {
    return null;
  }
  const slotHeight = columnHeight / slotCount;
  const slotCenter = railY + columnY + (slotIndex + 0.5) * slotHeight;
  return Math.max(0, slotCenter - fingerClearance - previewHeight);
}

export type OutlineAccessibilityAction = "increment" | "decrement";

export interface OutlineAccessibilityStep {
  activeIndex: number;
  action: OutlineAccessibilityAction;
  count: number;
}

/**
 * The prompt an adjustable control steps to. With no active prompt, increment enters at the
 * first prompt and decrement has nothing earlier to reach. The ends do not wrap.
 */
export function resolveOutlineAccessibilityIndex(step: OutlineAccessibilityStep): number | null {
  const { activeIndex, action, count } = step;
  if (count < 1) {
    return null;
  }
  if (activeIndex < 0) {
    return action === "increment" ? 0 : null;
  }
  const next = activeIndex + (action === "increment" ? 1 : -1);
  if (next < 0 || next >= count) {
    return null;
  }
  return next;
}

/**
 * The prompt whose turn the reader is inside: the last indexed prompt at or before the
 * timeline position under the top of the viewport. It reads the complete daemon index,
 * so a prompt outside the loaded window still lights up while its turn is on screen.
 */
export function resolveActivePromptSeq(
  prompts: readonly ChatOutlinePrompt[],
  anchorSeq: number | null,
): number | null {
  if (anchorSeq === null) {
    return null;
  }
  let activeSeq: number | null = null;
  for (const prompt of prompts) {
    if (prompt.seq > anchorSeq) {
      break;
    }
    activeSeq = prompt.seq;
  }
  return activeSeq;
}

export interface ActivePromptSource {
  subscribe: (listener: () => void) => () => void;
  getActiveSeq: () => number | null;
  getRequestedSeq: () => number | null;
}

export interface ActivePromptPublisher extends ActivePromptSource {
  publish: (seq: number | null) => void;
  request: (seq: number | null) => void;
}

/**
 * The transcript reports its reading position on every scroll frame, far more often than
 * it re-renders. Keeping the active prompt outside React lets the rail subscribe to it
 * without dragging the transcript through a render on each frame.
 */
export function createActivePromptPublisher(): ActivePromptPublisher {
  const listeners = new Set<() => void>();
  let activeSeq: number | null = null;
  let requestedSeq: number | null = null;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getActiveSeq: () => activeSeq,
    getRequestedSeq: () => requestedSeq,
    request(seq) {
      if (seq === requestedSeq) return;
      requestedSeq = seq;
      for (const listener of listeners) listener();
    },
    publish(seq) {
      if (seq === activeSeq) {
        return;
      }
      activeSeq = seq;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/** Where the reader is: the timeline position under the top of the viewport, and whether
 * the row there is itself a prompt. */
export interface ReadingPosition {
  seq: number;
  isPromptRow: boolean;
}

export interface ReadingRow {
  item: StreamItem;
  aboveItem: StreamItem | null;
}

/**
 * Display rows such as Markdown blocks, live rows and optimistic prompts carry no timeline
 * cursor of their own. They belong to the turn of the nearest earlier row that has one, so a
 * reader parked on them still sits inside that turn.
 */
export function resolveReadingPosition(
  rowId: string | null,
  getRow: (id: string) => ReadingRow | undefined,
): ReadingPosition | null {
  let row = rowId === null ? undefined : getRow(rowId);
  const isPromptRow = row?.item.kind === "user_message";
  while (row) {
    const seq = row.item.timelineCursor?.seq;
    if (seq !== undefined) {
      return { seq, isPromptRow };
    }
    row = row.aboveItem ? getRow(row.aboveItem.id) : undefined;
  }
  return null;
}
