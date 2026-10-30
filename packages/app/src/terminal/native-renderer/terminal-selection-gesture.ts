import type {
  TerminalInputModeTracker,
  TerminalMousePosition,
} from "@getpaseo/protocol/terminal-input-mode";
import type { TerminalGridCellMetrics } from "./terminal-grid-metrics";

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

export type TerminalScrollGestureRoute =
  | { kind: "none" }
  | { kind: "scrollback"; direction: "up" | "down"; rows: number }
  | { kind: "input"; data: string };

export interface TerminalScrollGestureRouteInput {
  state: TerminalScrollGestureState;
  currentDy: number;
  point: { x: number; y: number };
  metrics: TerminalGridCellMetrics;
  viewport: { rows: number; cols: number };
  inputMode: Pick<TerminalInputModeTracker, "encodeWheel">;
}

export interface TerminalScrollGestureRouteUpdate {
  state: TerminalScrollGestureState;
  route: TerminalScrollGestureRoute;
}

export type TerminalGestureAction = "none" | "focus" | "select" | "clear";

export interface TerminalGestureReleaseRouteInput extends TerminalGestureReleaseInput {
  point: { x: number; y: number };
  metrics: TerminalGridCellMetrics | null;
  viewport: { rows: number; cols: number } | null;
  inputMode: Pick<TerminalInputModeTracker, "encodeLeftClick">;
}

export interface TerminalGestureReleaseRoute {
  action: TerminalGestureAction;
  mouseInput: string | null;
}

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps a touch point to the visible grid; pixel reports stay integral at fractional cell sizes. */
function resolveTerminalMousePosition(input: {
  point: { x: number; y: number };
  metrics: TerminalGridCellMetrics;
  viewport: { rows: number; cols: number };
}): TerminalMousePosition {
  const { cellWidth, cellHeight } = input.metrics;
  const pixelX = clamp(
    Math.floor(input.point.x),
    0,
    Math.ceil(input.viewport.cols * cellWidth) - 1,
  );
  const pixelY = clamp(
    Math.floor(input.point.y),
    0,
    Math.ceil(input.viewport.rows * cellHeight) - 1,
  );
  return {
    col: Math.floor(pixelX / cellWidth) + 1,
    row: Math.floor(pixelY / cellHeight) + 1,
    pixelX: pixelX + 1,
    pixelY: pixelY + 1,
  };
}

/** A drag scrolls local scrollback unless the foreground app asked for wheel reports. */
export function routeTerminalScrollGesture(
  input: TerminalScrollGestureRouteInput,
): TerminalScrollGestureRouteUpdate {
  const { state, rowDelta } = advanceTerminalScrollGesture({
    state: input.state,
    currentDy: input.currentDy,
    cellHeight: input.metrics.cellHeight,
  });
  if (rowDelta === 0) {
    return { state, route: { kind: "none" } };
  }

  const direction = rowDelta > 0 ? "up" : "down";
  const rows = Math.abs(rowDelta);
  const report = input.inputMode.encodeWheel({
    direction,
    ...resolveTerminalMousePosition(input),
  });
  if (report === null) {
    return { state, route: { kind: "scrollback", direction, rows } };
  }
  return { state, route: { kind: "input", data: report.repeat(rows) } };
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

/**
 * Only a short tap on the live screen clicks; long press, drags and selection clears stay local.
 * The caller sends the click before focusing, so the keyboard resize cannot move the target cell.
 */
export function routeTerminalGestureRelease(
  input: TerminalGestureReleaseRouteInput,
): TerminalGestureReleaseRoute {
  const action = resolveTerminalGestureReleaseAction(input);
  const { metrics, viewport } = input;
  if (action !== "focus" || input.scrollMode !== "following" || !metrics || !viewport) {
    return { action, mouseInput: null };
  }
  const position = resolveTerminalMousePosition({ point: input.point, metrics, viewport });
  return { action, mouseInput: input.inputMode.encodeLeftClick(position) };
}
