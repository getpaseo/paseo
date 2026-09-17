import { describe, expect, it } from "vitest";
import {
  SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT,
  resolveSidebarNavGroupHeight,
  resolveSidebarNavGroupMaxHeight,
} from "./group-layout";

describe("resolveSidebarNavGroupMaxHeight", () => {
  it("caps the group at a third of the window", () => {
    expect(resolveSidebarNavGroupMaxHeight(900)).toBe(300);
    expect(resolveSidebarNavGroupMaxHeight(1000)).toBe(333);
  });

  it("keeps the fraction on the shortest windows the app runs at", () => {
    expect(resolveSidebarNavGroupMaxHeight(360)).toBe(120);
    expect(resolveSidebarNavGroupMaxHeight(200)).toBe(67);
    expect(resolveSidebarNavGroupMaxHeight(108)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
  });

  it("shows one row rather than nothing when the viewport is unusable", () => {
    expect(resolveSidebarNavGroupMaxHeight(60)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(0)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(Number.NaN)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(Number.POSITIVE_INFINITY)).toBe(
      SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT,
    );
  });
});

describe("resolveSidebarNavGroupHeight", () => {
  it("uses the default share until the owner drags the group", () => {
    expect(resolveSidebarNavGroupHeight({ requestedHeight: null, viewportHeight: 900 })).toBe(300);
  });

  it("honours a dragged height between one row and half the window", () => {
    expect(resolveSidebarNavGroupHeight({ requestedHeight: 480, viewportHeight: 900 })).toBe(450);
    expect(resolveSidebarNavGroupHeight({ requestedHeight: 120, viewportHeight: 900 })).toBe(120);
    expect(resolveSidebarNavGroupHeight({ requestedHeight: 10, viewportHeight: 900 })).toBe(
      SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT,
    );
  });

  it("never lets the ceiling fall below the default share", () => {
    // Half of a 100px window is still more than its default share, so half is the ceiling.
    expect(resolveSidebarNavGroupHeight({ requestedHeight: 900, viewportHeight: 100 })).toBe(50);
    // Half of a 60px window is less than one row, so the default share holds the ceiling up.
    expect(resolveSidebarNavGroupHeight({ requestedHeight: 900, viewportHeight: 60 })).toBe(
      resolveSidebarNavGroupMaxHeight(60),
    );
  });

  it("falls back to the default share when the height is not a number", () => {
    expect(resolveSidebarNavGroupHeight({ requestedHeight: Number.NaN, viewportHeight: 600 })).toBe(
      200,
    );
  });
});
