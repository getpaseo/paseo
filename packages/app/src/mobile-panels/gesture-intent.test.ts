import { describe, expect, it } from "vitest";

import { resolveMobilePanelGestureIntent } from "./gesture-intent";

describe("mobile panel gesture intent", () => {
  it("rejects a pending swipe when presentation changes before activation", () => {
    expect(
      resolveMobilePanelGestureIntent({
        enabled: false,
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: false,
        openEdge: null,
      }),
    ).toBe("fail");
  });

  it("blocks both panel-opening directions while the active surface owns horizontal dragging", () => {
    expect([
      resolveMobilePanelGestureIntent({
        enabled: true,
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: true,
        openEdge: null,
      }),
      resolveMobilePanelGestureIntent({
        enabled: true,
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
        enabled: true,
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: false,
        openEdge: null,
      }),
      resolveMobilePanelGestureIntent({
        enabled: true,
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
        enabled: true,
        ...swipe,
        deltaX: 40,
        direction: 1,
        openEdge: { startX: 200, windowWidth: 400 },
      }),
      resolveMobilePanelGestureIntent({
        enabled: true,
        ...swipe,
        deltaX: 40,
        direction: 1,
        openEdge: { startX: 12, windowWidth: 400 },
      }),
      resolveMobilePanelGestureIntent({
        enabled: true,
        ...swipe,
        deltaX: -40,
        direction: -1,
        openEdge: { startX: 200, windowWidth: 400 },
      }),
      resolveMobilePanelGestureIntent({
        enabled: true,
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
        enabled: true,
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: false,
        openEdge: null,
      }),
    ).toBe("activate");
  });
});
