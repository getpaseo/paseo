import { describe, expect, it } from "vitest";
import {
  resolveTabletSidebarSwipeAction,
  resolveTabletSidebarSwipe,
} from "./tablet-sidebar-swipe-intent";
const swipe = { translationX: 130, translationY: 3, velocityX: 0, width: 1280 };
describe("tablet chat sidebar swipes", () => {
  it("opens the left sidebar with a rightward swipe and right sidebar with a leftward swipe", () => {
    expect(resolveTabletSidebarSwipe(swipe)).toBe("left");
    expect(resolveTabletSidebarSwipe({ ...swipe, translationX: -130 })).toBe("right");
  });
  it("rejects taps, short drags, vertical and diagonal scrolls", () => {
    for (const input of [
      { translationX: 4, velocityX: 900 },
      { translationX: 40 },
      { translationY: 180 },
      { translationY: 100 },
    ]) {
      expect(resolveTabletSidebarSwipe({ ...swipe, ...input })).toBeNull();
    }
  });
  it("accepts deliberate flicks only with enough travel and matching velocity", () => {
    expect(resolveTabletSidebarSwipe({ ...swipe, translationX: 40, velocityX: 600 })).toBe("left");
    expect(resolveTabletSidebarSwipe({ ...swipe, translationX: -40, velocityX: -600 })).toBe(
      "right",
    );
    expect(resolveTabletSidebarSwipe({ ...swipe, translationX: 40, velocityX: -600 })).toBeNull();
  });
  it("uses a reachable distance on small tablets and caps the distance on large tablets", () => {
    expect(resolveTabletSidebarSwipe({ ...swipe, width: 600, translationX: 64 })).toBe("left");
    expect(resolveTabletSidebarSwipe({ ...swipe, width: 2560, translationX: 120 })).toBe("left");
  });
});

describe("tablet sidebar close precedence", () => {
  it("closes the left sidebar on a leftward swipe before opening the right", () => {
    expect(resolveTabletSidebarSwipeAction("right", { leftOpen: true, rightOpen: false })).toBe(
      "close-left",
    );
    expect(resolveTabletSidebarSwipeAction("right", { leftOpen: false, rightOpen: false })).toBe(
      "open-right",
    );
  });
  it("closes the right sidebar on a rightward swipe before opening the left", () => {
    expect(resolveTabletSidebarSwipeAction("left", { leftOpen: false, rightOpen: true })).toBe(
      "close-right",
    );
    expect(resolveTabletSidebarSwipeAction("left", { leftOpen: false, rightOpen: false })).toBe(
      "open-left",
    );
  });
  it("leaves the already-open sidebar open when swiped toward the center", () => {
    expect(resolveTabletSidebarSwipeAction("left", { leftOpen: true, rightOpen: false })).toBe(
      "open-left",
    );
    expect(resolveTabletSidebarSwipeAction("right", { leftOpen: false, rightOpen: true })).toBe(
      "open-right",
    );
  });
  it("closes only the sidebar matching the direction when both landscape docks are open", () => {
    expect(resolveTabletSidebarSwipeAction("left", { leftOpen: true, rightOpen: true })).toBe(
      "close-right",
    );
    expect(resolveTabletSidebarSwipeAction("right", { leftOpen: true, rightOpen: true })).toBe(
      "close-left",
    );
  });
});
