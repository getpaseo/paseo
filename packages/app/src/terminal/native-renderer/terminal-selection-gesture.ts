export type TerminalGestureStatus = "idle" | "pressing" | "selecting";
export type TerminalGestureIntent = "tap" | "pending" | "select" | "scroll";
export type TerminalGestureScrollMode = "following" | "scrolled";

export interface TerminalGestureMoveInput {
  status: TerminalGestureStatus;
  dx: number;
  dy: number;
  vx: number;
  vy: number;
  elapsedMs?: number;
}

export interface TerminalGestureReleaseInput {
  status: TerminalGestureStatus;
  startedWithSelection?: boolean;
  didScroll: boolean;
  didNavigate: boolean;
  movedBeyondTapTolerance: boolean;
  pressDurationMs: number;
  longPressMs: number;
  scrollMode: TerminalGestureScrollMode;
}

export interface TerminalScrollGestureState {
  lastDy: number;
  rowRemainder: number;
  didScroll: boolean;
}

export interface TerminalScrollGestureUpdate {
  state: TerminalScrollGestureState;
  rowDelta: number;
}

export type TerminalGestureAction = "none" | "focus" | "select" | "clear";

export const TERMINAL_GESTURE_TAP_TOLERANCE_PX = 8;
export const TERMINAL_GESTURE_LONG_PRESS_MS = 450;
export const TERMINAL_GESTURE_VERTICAL_SCROLL_THRESHOLD_PX = 12;

export function classifyTerminalGestureIntent(
  input: TerminalGestureMoveInput,
): TerminalGestureIntent {
  if (input.status === "selecting") {
    return "select";
  }

  const absDx = Math.abs(input.dx);
  const absDy = Math.abs(input.dy);

  if (absDy > TERMINAL_GESTURE_VERTICAL_SCROLL_THRESHOLD_PX && absDy > absDx) {
    return "scroll";
  }

  if (Math.hypot(input.dx, input.dy) > TERMINAL_GESTURE_TAP_TOLERANCE_PX) {
    return "pending";
  }

  return "tap";
}

export function advanceTerminalScrollGesture(input: {
  state: TerminalScrollGestureState;
  currentDy: number;
  cellHeight: number;
}): TerminalScrollGestureUpdate {
  const deltaY = input.currentDy - input.state.lastDy;
  const accumulatedRows = input.state.rowRemainder + deltaY;
  const rowDelta = Math.trunc(accumulatedRows / input.cellHeight);
  return {
    state: {
      lastDy: input.currentDy,
      rowRemainder: accumulatedRows - rowDelta * input.cellHeight,
      didScroll: input.state.didScroll || rowDelta !== 0,
    },
    rowDelta,
  };
}

export function resolveTerminalGestureReleaseAction(
  input: TerminalGestureReleaseInput,
): TerminalGestureAction {
  if (input.didScroll || input.didNavigate) {
    return "none";
  }

  if (input.status === "selecting") {
    if (!input.startedWithSelection) {
      return "none";
    }
    return input.movedBeyondTapTolerance ? "none" : "clear";
  }

  if (input.status !== "pressing") {
    return "none";
  }

  if (input.pressDurationMs >= input.longPressMs) {
    return "select";
  }

  if (input.movedBeyondTapTolerance) {
    return "none";
  }

  return "focus";
}
