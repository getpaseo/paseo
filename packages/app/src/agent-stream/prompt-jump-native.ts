import type { BottomAnchorLocalRequest } from "./bottom-anchor-controller";
import { PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";

/** A measured row must sit this close to the landing offset before the jump holds still. */
export const NATIVE_PROMPT_JUMP_TOLERANCE_PX = 2;
/** Two quiet samples, matching the web settle, so a one-frame remeasure does not count as landed. */
export const NATIVE_PROMPT_JUMP_STABLE_SAMPLES = 2;
/** Corrections after the row has a frame. Walking an unmeasured index has its own budget. */
export const NATIVE_PROMPT_JUMP_SAMPLE_BUDGET = 24;
/**
 * How many times to advance the measured window before giving up on an unmounted row.
 * Each step mounts one FlatList batch; a long Markdown transcript is hundreds of rows.
 */
export const NATIVE_PROMPT_JUMP_APPROACH_BUDGET = 80;

/**
 * `viewPosition` for the furthest measured row while the target is still unmounted.
 * VirtualizedList's overscan past the viewport is half of `(windowSize - 1)` viewports.
 * A row taller than that distance hides every following row when its start is pinned,
 * and the measured index stops. Pinning its far edge (`1`) puts the next row in the overscan.
 * A shorter row keeps `0`, which fills the viewport with the following rows.
 */
export interface MeasuredWindowRevealInput {
  frameHeight: number;
  viewportHeight: number;
  windowSize: number;
}

export function resolveMeasuredWindowRevealPosition(input: MeasuredWindowRevealInput): 0 | 1 {
  if (input.frameHeight <= 0 || input.viewportHeight <= 0 || input.windowSize <= 1) {
    return 1;
  }
  const overscanPastViewport = ((input.windowSize - 1) / 2) * input.viewportHeight;
  if (input.frameHeight > input.viewportHeight + overscanPastViewport) {
    return 1;
  }
  return 0;
}

export interface InvertedPromptJumpFrame {
  y: number;
  height: number;
}

export interface InvertedPromptJumpOffsetInput {
  frameY: number;
  frameHeight: number;
  viewportHeight: number;
  topInset: number;
}

export interface InvertedPromptJumpMeasurement {
  frame: InvertedPromptJumpFrame | null;
  offsetY: number;
  viewportHeight: number;
  contentHeight: number;
  topInset: number;
  /** Samples already spent. An unmeasured row does not spend one. */
  sampled: number;
  /** Consecutive samples already within tolerance. */
  stable: number;
}

export type InvertedPromptJumpStep =
  | { kind: "correct"; offset: number; sampled: number; stable: number }
  | { kind: "hold"; sampled: number; stable: number }
  | { kind: "settled" }
  | { kind: "unmeasured" }
  | { kind: "stopped" };

/**
 * Offset that puts an inverted row's far edge just below the floating header.
 *
 * The list's content `y` grows toward older rows, and the scroll view's scaleY flip
 * shows `y + height` at the visual top of that row. This is the offset VirtualizedList
 * computes for `viewPosition: 1` and `viewOffset: -(topInset + 8)`. The settle loop
 * applies it from the row's own layout because `scrollToIndex` stops once the index is
 * merely estimated, and a later remeasure never calls `onScrollToIndexFailed`.
 */
export function resolveInvertedPromptJumpOffset(input: InvertedPromptJumpOffsetInput): number {
  const offset =
    input.frameY +
    input.frameHeight -
    input.viewportHeight +
    input.topInset +
    PROMPT_JUMP_TOP_INSET_PX;
  return Math.max(0, offset);
}

export function stepInvertedPromptJump(
  input: InvertedPromptJumpMeasurement,
): InvertedPromptJumpStep {
  if (input.sampled >= NATIVE_PROMPT_JUMP_SAMPLE_BUDGET) {
    return { kind: "stopped" };
  }
  const frame = input.frame;
  if (
    frame === null ||
    frame.height <= 0 ||
    input.viewportHeight <= 0 ||
    input.contentHeight <= 0
  ) {
    return { kind: "unmeasured" };
  }
  const offset = resolveInvertedPromptJumpOffset({
    frameY: frame.y,
    frameHeight: frame.height,
    viewportHeight: input.viewportHeight,
    topInset: input.topInset,
  });
  const maxOffset = Math.max(0, input.contentHeight - input.viewportHeight);
  const sampled = input.sampled + 1;
  // The cell can lay out before the scroll content grows to include it. Clamping
  // now would park the row short of the header and look like a landed jump.
  if (offset > maxOffset + NATIVE_PROMPT_JUMP_TOLERANCE_PX) {
    return { kind: "hold", sampled, stable: 0 };
  }
  const delta = offset - input.offsetY;
  if (Math.abs(delta) <= NATIVE_PROMPT_JUMP_TOLERANCE_PX) {
    const stable = input.stable + 1;
    if (stable >= NATIVE_PROMPT_JUMP_STABLE_SAMPLES) {
      return { kind: "settled" };
    }
    return { kind: "hold", sampled, stable };
  }
  return { kind: "correct", offset, sampled, stable: 0 };
}

export interface NativePromptJump {
  messageId: string;
  sampled: number;
  stable: number;
  approachSteps: number;
}

export interface NativePromptJumpSessionPort {
  schedule: (callback: () => void) => () => void;
  setBatchActive: (active: boolean) => void;
  requestBottomAnchor: (request: BottomAnchorLocalRequest) => void;
}

/** The landing loop owns one timer until navigation, a gesture, or reinitialization takes over. */
export function createNativePromptJumpSession(port: NativePromptJumpSessionPort) {
  let current: NativePromptJump | null = null;
  let cancelTimer: (() => void) | null = null;

  function cancel() {
    cancelTimer?.();
    cancelTimer = null;
    current = null;
  }

  function endPromptJump() {
    cancel();
    port.setBatchActive(false);
  }

  return {
    getCurrent: () => current,
    begin(messageId: string) {
      cancel();
      current = { messageId, sampled: 0, stable: 0, approachSteps: 0 };
      port.setBatchActive(true);
    },
    schedule(tick: () => void) {
      const scheduledJump = current;
      if (scheduledJump === null) return;
      cancelTimer?.();
      cancelTimer = port.schedule(() => {
        if (current !== scheduledJump) return;
        cancelTimer = null;
        tick();
      });
    },
    cancel,
    end: endPromptJump,
    requestBottomAnchor(request: BottomAnchorLocalRequest) {
      endPromptJump();
      port.requestBottomAnchor(request);
    },
  };
}
