import { describe, expect, it } from "vitest";

import {
  TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX,
  TERMINAL_GESTURE_LONG_PRESS_MS,
  TERMINAL_GESTURE_TAP_TOLERANCE_PX,
  TERMINAL_GESTURE_VERTICAL_SCROLL_THRESHOLD_PX,
  classifyTerminalGestureIntent,
  resolveTerminalGestureReleaseAction,
} from "./terminal-selection-gesture";

describe("native terminal gesture policy", () => {
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

    it("treats horizontal movement beyond tap tolerance as navigation", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX + 1,
          dy: 4,
          vx: 0,
          vy: 0,
        }),
      ).toEqual("swipeRight");
    });

    it("does not infer selection from slow horizontal drag dwell", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX + 20,
          dy: 3,
          vx: 0,
          vy: 0,
          elapsedMs: TERMINAL_GESTURE_LONG_PRESS_MS + 50,
        }),
      ).toEqual("swipeRight");
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
          dx: TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX - 1,
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

    it("treats a fast rightward swipe as sidebar navigation", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX + 20,
          dy: 4,
          vx: 2,
          vy: 0,
        }),
      ).toEqual("swipeRight");
    });

    it("treats a slow rightward swipe as sidebar navigation", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX + 20,
          dy: 4,
          vx: 0,
          vy: 0,
        }),
      ).toEqual("swipeRight");
    });

    it("treats a fast leftward swipe as explorer navigation", () => {
      expect(
        classifyTerminalGestureIntent({
          status: "pressing",
          dx: -(TERMINAL_GESTURE_HORIZONTAL_NAVIGATION_THRESHOLD_PX + 20),
          dy: -4,
          vx: -2,
          vy: 0,
        }),
      ).toEqual("swipeLeft");
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
});
