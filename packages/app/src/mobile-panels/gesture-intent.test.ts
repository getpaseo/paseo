import { describe, expect, it } from "vitest";

import { resolveMobilePanelGestureIntent } from "./gesture-intent";

describe("mobile panel gesture intent", () => {
  it("blocks both panel-opening directions while the active surface owns horizontal dragging", () => {
    expect([
      resolveMobilePanelGestureIntent({
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: true,
        openEdge: null,
      }),
      resolveMobilePanelGestureIntent({
        deltaX: -40,
        deltaY: 2,
        direction: -1,
        openGesturesBlocked: true,
        openEdge: null,
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
        openEdge: null,
      }),
      resolveMobilePanelGestureIntent({
        deltaX: -40,
        deltaY: 2,
        direction: -1,
        openGesturesBlocked: false,
        openEdge: null,
      }),
    ]).toEqual(["activate", "activate"]);
  });

  it("opens phone web drawers only from the edge they slide in from", () => {
    const swipe = { deltaY: 2, openGesturesBlocked: false };
    expect([
      resolveMobilePanelGestureIntent({
        ...swipe,
        deltaX: 40,
        direction: 1,
        openEdge: { startX: 200, windowWidth: 400 },
      }),
      resolveMobilePanelGestureIntent({
        ...swipe,
        deltaX: 40,
        direction: 1,
        openEdge: { startX: 12, windowWidth: 400 },
      }),
      resolveMobilePanelGestureIntent({
        ...swipe,
        deltaX: -40,
        direction: -1,
        openEdge: { startX: 200, windowWidth: 400 },
      }),
      resolveMobilePanelGestureIntent({
        ...swipe,
        deltaX: -40,
        direction: -1,
        openEdge: { startX: 388, windowWidth: 400 },
      }),
    ]).toEqual(["fail", "activate", "fail", "activate"]);
  });

  it("opens from anywhere when the layout does not require an edge start", () => {
    expect(
      resolveMobilePanelGestureIntent({
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: false,
        openEdge: null,
      }),
    ).toBe("activate");
  });
});
