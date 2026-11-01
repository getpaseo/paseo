import { describe, expect, it } from "vitest";

import { canStartMobilePanelOpenGesture, resolveMobilePanelGestureIntent } from "./gesture-intent";

describe("mobile panel gesture intent", () => {
  it("reserves the entire header, including both edges, without reserving the row below", () => {
    const header = { x: 0, y: 24, width: 390, height: 64 };
    for (const [x, direction] of [
      [0, 1],
      [32, 1],
      [358, -1],
      [390, -1],
    ] as const) {
      const input = { x, direction, windowWidth: 390, exclusions: [header] };
      expect(canStartMobilePanelOpenGesture({ ...input, y: 24 })).toBe(false);
      expect(canStartMobilePanelOpenGesture({ ...input, y: 87 })).toBe(false);
      expect(canStartMobilePanelOpenGesture({ ...input, y: 88 })).toBe(true);
    }
  });

  it("only opens panels from the matching 32px edge, including when the header is absent", () => {
    for (const direction of [1, -1] as const) {
      for (const x of [33, 195, 357]) {
        expect(
          canStartMobilePanelOpenGesture({
            x,
            y: 100,
            direction,
            windowWidth: 390,
            exclusions: [],
          }),
        ).toBe(false);
      }
    }
    expect(
      canStartMobilePanelOpenGesture({
        x: 390,
        y: 100,
        direction: 1,
        windowWidth: 390,
        exclusions: [],
      }),
    ).toBe(false);
    expect(
      canStartMobilePanelOpenGesture({
        x: 0,
        y: 100,
        direction: -1,
        windowWidth: 390,
        exclusions: [],
      }),
    ).toBe(false);
    expect(
      canStartMobilePanelOpenGesture({
        x: 0,
        y: 100,
        direction: 1,
        windowWidth: 390,
        exclusions: [],
      }),
    ).toBe(true);
    expect(
      canStartMobilePanelOpenGesture({
        x: 390,
        y: 100,
        direction: -1,
        windowWidth: 390,
        exclusions: [],
      }),
    ).toBe(true);
  });

  it("blocks both panel-opening directions while the active surface owns horizontal dragging", () => {
    expect([
      resolveMobilePanelGestureIntent({
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: true,
      }),
      resolveMobilePanelGestureIntent({
        deltaX: -40,
        deltaY: 2,
        direction: -1,
        openGesturesBlocked: true,
      }),
    ]).toEqual(["fail", "fail"]);
  });

  it("keeps ordinary horizontal panel gestures available when unblocked", () => {
    expect([
      resolveMobilePanelGestureIntent({
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: false,
      }),
      resolveMobilePanelGestureIntent({
        deltaX: -40,
        deltaY: 2,
        direction: -1,
        openGesturesBlocked: false,
      }),
    ]).toEqual(["activate", "activate"]);
  });
});
