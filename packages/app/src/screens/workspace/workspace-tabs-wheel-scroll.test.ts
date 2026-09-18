import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceTabsScrollElement,
  resolveWorkspaceTabsWheelScroll,
} from "@/screens/workspace/workspace-tabs-wheel-scroll";

const overflowingStrip = {
  scrollLeft: 0,
  scrollWidth: 1600,
  clientWidth: 800,
  deltaX: 0,
  deltaY: 120,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
};

describe("resolveWorkspaceTabsWheelScroll", () => {
  it("pans a vertical wheel across the overflowing strip", () => {
    const result = resolveWorkspaceTabsWheelScroll(overflowingStrip);

    expect(result).toEqual({ scrollLeft: 120, handled: true });
  });

  it("continues from the current offset and clamps at the far edge", () => {
    expect(resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, scrollLeft: 700 })).toEqual({
      scrollLeft: 800,
      handled: true,
    });
    expect(resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, scrollLeft: 800 })).toEqual({
      scrollLeft: 800,
      handled: false,
    });
  });

  it("clamps a wheel back up at the leading edge and leaves the event unhandled there", () => {
    expect(
      resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, scrollLeft: 40, deltaY: -120 }),
    ).toEqual({ scrollLeft: 0, handled: true });
    expect(
      resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, scrollLeft: 0, deltaY: -120 }),
    ).toEqual({ scrollLeft: 0, handled: false });
  });

  it("does nothing while the strip fits its viewport", () => {
    expect(resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, scrollWidth: 800 })).toEqual({
      scrollLeft: 0,
      handled: false,
    });
  });

  it("leaves horizontal gestures and browser zoom to the browser", () => {
    expect(resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, deltaX: 40 })).toEqual({
      scrollLeft: 0,
      handled: false,
    });
    expect(resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, shiftKey: true })).toEqual({
      scrollLeft: 0,
      handled: false,
    });
    // macOS trackpad pinch and Windows/Linux ctrl+wheel emit ctrlKey wheel events.
    expect(resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, ctrlKey: true })).toEqual({
      scrollLeft: 0,
      handled: false,
    });
  });

  it("normalizes line and page deltas to pixels", () => {
    expect(
      resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, deltaY: 3, deltaMode: 1 }),
    ).toEqual({ scrollLeft: 48, handled: true });
    expect(
      resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, deltaY: 1, deltaMode: 2 }),
    ).toEqual({ scrollLeft: 800, handled: true });
  });

  it("ignores an empty wheel event", () => {
    expect(resolveWorkspaceTabsWheelScroll({ ...overflowingStrip, deltaY: 0 })).toEqual({
      scrollLeft: 0,
      handled: false,
    });
  });
});

describe("resolveWorkspaceTabsScrollElement", () => {
  function scrollElement() {
    return {
      scrollLeft: 0,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  }

  it("prefers the node exposed by a React Native Web ScrollView ref", () => {
    const node = scrollElement();
    const handle = { getScrollableNode: () => node };

    expect(resolveWorkspaceTabsScrollElement(handle)).toBe(node);
  });

  it("uses the ref directly when it already is the scrollable element", () => {
    const node = scrollElement();

    expect(resolveWorkspaceTabsScrollElement(node)).toBe(node);
  });

  it("returns null when the ref exposes no scrollable element", () => {
    expect(resolveWorkspaceTabsScrollElement(null)).toBeNull();
    expect(resolveWorkspaceTabsScrollElement(undefined)).toBeNull();
    expect(resolveWorkspaceTabsScrollElement({ getScrollableNode: () => null })).toBeNull();
    // A ref shape without `addEventListener` cannot hold the wheel listener.
    expect(resolveWorkspaceTabsScrollElement({ scrollLeft: 0 })).toBeNull();
    expect(
      resolveWorkspaceTabsScrollElement({ getScrollableNode: () => ({ scrollLeft: 0 }) }),
    ).toBeNull();
  });
});
