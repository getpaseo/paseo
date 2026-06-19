export type TerminalGestureStatus = "idle" | "pressing" | "selecting";
export type TerminalGestureIntent =
  | "tap"
  | "pending"
  | "select"
  | "scroll"
  | "swipeLeft"
  | "swipeRight";
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
  didScroll: boolean;
  didNavigate: boolean;
  movedBeyondTapTolerance: boolean;
  pressDurationMs: number;
  longPressMs: number;
  scrollMode: TerminalGestureScrollMode;
}

export type TerminalGestureAction = "none" | "focus" | "select";

export const TERMINAL_GESTURE_TAP_TOLERANCE_PX = 8;
export const TERMINAL_GESTURE_LONG_PRESS_MS = 650;
export const TERMINAL_GESTURE_VERTICAL_SCROLL_THRESHOLD_PX = 12;
export const TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX = 24;

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
    if (absDx > absDy) {
      if (absDx <= TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX) {
        return "pending";
      }
      return input.dx > 0 ? "swipeRight" : "swipeLeft";
    }

    return "pending";
  }

  return "tap";
}

export function resolveTerminalGestureReleaseAction(
  input: TerminalGestureReleaseInput,
): TerminalGestureAction {
  if (input.status === "selecting" || input.didScroll || input.didNavigate) {
    return "none";
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
