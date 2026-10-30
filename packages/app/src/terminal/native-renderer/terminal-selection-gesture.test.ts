import { describe, expect, it } from "vitest";
import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";

import {
  TERMINAL_GESTURE_LONG_PRESS_MS,
  TERMINAL_GESTURE_TAP_TOLERANCE_PX,
  TERMINAL_GESTURE_VERTICAL_SCROLL_THRESHOLD_PX,
  advanceTerminalScrollGesture,
  classifyTerminalGestureIntent,
  resolveTerminalGestureReleaseAction,
  routeTerminalGestureRelease,
  routeTerminalScrollGesture,
  type TerminalGestureReleaseRouteInput,
  type TerminalScrollGestureRoute,
} from "./terminal-selection-gesture";

const PI_FULLSCREEN_MOUSE_ENABLE =
  "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const PI_FULLSCREEN_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

function trackerFromOutput(output: string): TerminalInputModeTracker {
  const tracker = new TerminalInputModeTracker();
  tracker.feed(output);
  return tracker;
}

function dragRoutes(input: {
  inputMode: TerminalInputModeTracker;
  dys: number[];
  point?: { x: number; y: number };
}): TerminalScrollGestureRoute[] {
  let state = { lastDy: 0, rowRemainder: 0, didScroll: false };
  const routes: TerminalScrollGestureRoute[] = [];
  for (const currentDy of input.dys) {
    const update = routeTerminalScrollGesture({
      state,
      currentDy,
      point: input.point ?? { x: 25, y: 50 },
      metrics: { cellWidth: 8, cellHeight: 14 },
      viewport: { rows: 30, cols: 40 },
      inputMode: input.inputMode,
    });
    state = update.state;
    routes.push(update.route);
  }
  return routes;
}

function tapRelease(
  overrides: Partial<TerminalGestureReleaseRouteInput> = {},
): ReturnType<typeof routeTerminalGestureRelease> {
  return routeTerminalGestureRelease({
    status: "pressing",
    startedWithSelection: false,
    didScroll: false,
    didNavigate: false,
    movedBeyondTapTolerance: false,
    pressDurationMs: 80,
    longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
    scrollMode: "following",
    point: { x: 25, y: 50 },
    metrics: { cellWidth: 8, cellHeight: 14 },
    viewport: { rows: 30, cols: 40 },
    inputMode: trackerFromOutput(PI_FULLSCREEN_MOUSE_ENABLE),
    ...overrides,
  });
}

describe("native terminal gesture policy", () => {
  describe("advanceTerminalScrollGesture", () => {
    it("keeps consuming a slow drag after scroll intent arms below one row", () => {
      let state = { lastDy: 0, rowRemainder: 0, didScroll: false };
      const rowDeltas: number[] = [];

      for (const currentDy of [13, 15, 18, 22, 28]) {
        const update = advanceTerminalScrollGesture({
          state,
          currentDy,
          cellHeight: 14,
        });
        state = update.state;
        rowDeltas.push(update.rowDelta);
      }

      expect({ rowDeltas, state }).toEqual({
        rowDeltas: [0, 1, 0, 0, 1],
        state: { lastDy: 28, rowRemainder: 0, didScroll: true },
      });
    });
  });

  describe("classifyTerminalGestureIntent", () => {
    it("treats a motionless press as a tap", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: 0,
          dy: 0,
          vx: 0,
          vy: 0,
        }),
      ).toEqual("tap");
    });

    it("treats a tiny jitter within tap tolerance as a tap", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_TAP_TOLERANCE_PX - 4,
          dy: TERMINAL_GESTURE_TAP_TOLERANCE_PX - 4,
          vx: 0,
          vy: 0,
        }),
      ).toEqual("tap");
    });

    it("leaves horizontal movement available to terminal selection", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_TAP_TOLERANCE_PX + 20,
          dy: 4,
          vx: 0,
          vy: 0,
        }),
      ).toEqual("pending");
    });

    it("does not infer selection from slow horizontal drag dwell", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_TAP_TOLERANCE_PX + 40,
          dy: 3,
          vx: 0,
          vy: 0,
          elapsedMs: TERMINAL_GESTURE_LONG_PRESS_MS + 50,
        }),
      ).toEqual("pending");
    });

    it("keeps tiny horizontal jitter inside tap tolerance as a tap", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_TAP_TOLERANCE_PX - 1,
          dy: 1,
          vx: 2,
          vy: 0,
          elapsedMs: 20,
        }),
      ).toEqual("tap");
    });

    it("keeps horizontal movement below navigation distance pending", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_TAP_TOLERANCE_PX + 10,
          dy: 2,
          vx: 0,
          vy: 0,
        }),
      ).toEqual("pending");
    });

    it("treats a clearly vertical drag as scroll", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: 4,
          dy: TERMINAL_GESTURE_VERTICAL_SCROLL_THRESHOLD_PX + 5,
          vx: 0,
          vy: 0.2,
        }),
      ).toEqual("scroll");
    });

    it("does not navigate on a fast rightward swipe", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_TAP_TOLERANCE_PX + 40,
          dy: 4,
          vx: 2,
          vy: 0,
        }),
      ).toEqual("pending");
    });

    it("does not navigate on a slow rightward swipe", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_TAP_TOLERANCE_PX + 40,
          dy: 4,
          vx: 0,
          vy: 0,
        }),
      ).toEqual("pending");
    });

    it("does not navigate on a fast leftward swipe", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: -(TERMINAL_GESTURE_TAP_TOLERANCE_PX + 40),
          dy: -4,
          vx: -2,
          vy: 0,
        }),
      ).toEqual("pending");
    });

    it("does not navigate while movement stays inside tap tolerance", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_TAP_TOLERANCE_PX - 1,
          dy: 2,
          vx: 2,
          vy: 0,
        }),
      ).toEqual("tap");
    });

    it("keeps selection intent once selection is active", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "selecting",
          dx: 100,
          dy: 50,
          vx: 2,
          vy: 1,
        }),
      ).toEqual("select");
    });
  });

  describe("resolveTerminalGestureReleaseAction", () => {
    it("focuses the terminal after a normal tap", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "pressing",
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: false,
          pressDurationMs: 80,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("focus");
    });

    it("focuses the terminal after a normal tap while scrolled", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "pressing",
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: false,
          pressDurationMs: 80,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "scrolled",
        }),
      ).toEqual("focus");
    });

    it("starts selection after a long press", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "pressing",
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: false,
          pressDurationMs: TERMINAL_GESTURE_LONG_PRESS_MS + 50,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("select");
    });

    it("starts selection after a 500ms hold", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "pressing",
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: false,
          pressDurationMs: 500,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("select");
    });

    it("keeps a 400ms press as a tap", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "pressing",
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: false,
          pressDurationMs: 400,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("focus");
    });

    it("does nothing after a scroll gesture", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "pressing",
          didScroll: true,
          didNavigate: false,
          movedBeyondTapTolerance: true,
          pressDurationMs: 80,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "scrolled",
        }),
      ).toEqual("none");
    });

    it("does nothing after a navigation swipe", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "pressing",
          didScroll: false,
          didNavigate: true,
          movedBeyondTapTolerance: true,
          pressDurationMs: 80,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("none");
    });

    it("does nothing while actively selecting", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "selecting",
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: true,
          pressDurationMs: 80,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("none");
    });

    it("clears an existing selection after a short tap", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "selecting",
          startedWithSelection: true,
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: false,
          pressDurationMs: 80,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("clear");
    });

    it("preserves a word selection created by the current long press", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "selecting",
          startedWithSelection: false,
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: false,
          pressDurationMs: TERMINAL_GESTURE_LONG_PRESS_MS + 50,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("none");
    });

    it("does not focus after an undecided fast drag", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "pressing",
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: true,
          pressDurationMs: 80,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("none");
    });

    it("does nothing from idle", () => {
      expect(
        resolveTerminalGestureReleaseAction({
          status: "idle",
          didScroll: false,
          didNavigate: false,
          movedBeyondTapTolerance: false,
          pressDurationMs: 80,
          longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
          scrollMode: "following",
        }),
      ).toEqual("none");
    });
  });
  describe("routeTerminalScrollGesture", () => {
    it("sends SGR wheel reports at the touched cell while a fullscreen app tracks the mouse", () => {
      const inputMode = trackerFromOutput(PI_FULLSCREEN_MOUSE_ENABLE);

      expect(dragRoutes({ inputMode, dys: [13, 28, 42, 14] })).toEqual([
        { kind: "none" },
        { kind: "input", data: "\x1b[<64;4;4M\x1b[<64;4;4M" },
        { kind: "input", data: "\x1b[<64;4;4M" },
        { kind: "input", data: "\x1b[<65;4;4M\x1b[<65;4;4M" },
      ]);
    });

    it("keeps ordinary shell drags in local scrollback", () => {
      const inputMode = trackerFromOutput("\x1b[?2004h$ ls\r\n");

      expect(dragRoutes({ inputMode, dys: [13, 28, 14] })).toEqual([
        { kind: "none" },
        { kind: "scrollback", direction: "up", rows: 2 },
        { kind: "scrollback", direction: "down", rows: 1 },
      ]);
    });

    it("returns drags to local scrollback after the app disables mouse tracking", () => {
      const inputMode = trackerFromOutput(PI_FULLSCREEN_MOUSE_ENABLE);
      inputMode.feed(PI_FULLSCREEN_MOUSE_DISABLE);

      expect(dragRoutes({ inputMode, dys: [28] })).toEqual([
        { kind: "scrollback", direction: "up", rows: 2 },
      ]);
    });

    it("keeps forwarding wheel input after a reconnect replays the daemon preamble", () => {
      const daemon = trackerFromOutput(PI_FULLSCREEN_MOUSE_ENABLE);
      const client = trackerFromOutput(PI_FULLSCREEN_MOUSE_ENABLE);
      client.reset();
      client.feed(daemon.getPreamble());

      expect(dragRoutes({ inputMode: client, dys: [14] })).toEqual([
        { kind: "input", data: "\x1b[<64;4;4M" },
      ]);
    });

    it("keeps pixel reports integral at fractional cell boundaries", () => {
      const inputMode = trackerFromOutput("\x1b[?1003h\x1b[?1016h");
      const { route } = routeTerminalScrollGesture({
        state: { lastDy: 0, rowRemainder: 0, didScroll: false },
        currentDy: 15,
        point: { x: 999, y: 999 },
        metrics: { cellWidth: 8.25, cellHeight: 14.25 },
        viewport: { rows: 3, cols: 3 },
        inputMode,
      });
      expect(route).toEqual({ kind: "input", data: "\x1b[<64;25;43M" });
    });

    it("clamps wheel reports to the visible grid", () => {
      const inputMode = trackerFromOutput(PI_FULLSCREEN_MOUSE_ENABLE);

      expect(dragRoutes({ inputMode, dys: [-14], point: { x: 999, y: -5 } })).toEqual([
        { kind: "input", data: "\x1b[<65;40;1M" },
      ]);
    });
  });

  describe("routeTerminalGestureRelease", () => {
    it("clicks the tapped cell and still focuses while a fullscreen app tracks the mouse", () => {
      expect(tapRelease()).toEqual({
        action: "focus",
        mouseInput: "\x1b[<0;4;4M\x1b[<0;4;4m",
      });
    });

    it("only focuses on an ordinary shell tap", () => {
      expect(tapRelease({ inputMode: trackerFromOutput("\x1b[?2004h$ ls\r\n") })).toEqual({
        action: "focus",
        mouseInput: null,
      });
    });

    it("sends only the press for X10 tracking", () => {
      expect(tapRelease({ inputMode: trackerFromOutput("\x1b[?9h") })).toEqual({
        action: "focus",
        mouseInput: "\x1b[M $$",
      });
    });

    it("keeps a long press as local selection without clicking", () => {
      expect(tapRelease({ pressDurationMs: TERMINAL_GESTURE_LONG_PRESS_MS + 50 })).toEqual({
        action: "select",
        mouseInput: null,
      });
    });

    it.each([
      ["moved beyond tap tolerance", { movedBeyondTapTolerance: true }],
      ["scrolled", { didScroll: true }],
    ])("never clicks after a drag that %s", (_name, overrides) => {
      expect(tapRelease(overrides)).toEqual({ action: "none", mouseInput: null });
    });

    it("clears an existing selection without clicking", () => {
      expect(tapRelease({ status: "selecting", startedWithSelection: true })).toEqual({
        action: "clear",
        mouseInput: null,
      });
    });

    it("does not send live mouse input from a scrolled-back viewport", () => {
      expect(tapRelease({ scrollMode: "scrolled" })).toEqual({
        action: "focus",
        mouseInput: null,
      });
    });

    it("does not click before the grid is measured", () => {
      expect(tapRelease({ metrics: null, viewport: null })).toEqual({
        action: "focus",
        mouseInput: null,
      });
    });

    it("clamps clicks to the visible grid", () => {
      expect(tapRelease({ point: { x: 999, y: -5 } })).toEqual({
        action: "focus",
        mouseInput: "\x1b[<0;40;1M\x1b[<0;40;1m",
      });
    });

    it("keeps pixel clicks integral at fractional cell boundaries", () => {
      expect(
        tapRelease({
          inputMode: trackerFromOutput("\x1b[?1000h\x1b[?1016h"),
          point: { x: 999, y: 999 },
          metrics: { cellWidth: 8.25, cellHeight: 14.25 },
          viewport: { rows: 3, cols: 3 },
        }),
      ).toEqual({ action: "focus", mouseInput: "\x1b[<0;25;43M\x1b[<0;25;43m" });
    });
  });
});
