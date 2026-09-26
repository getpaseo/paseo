import { describe, expect, it } from "vitest";
import { SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT, resolveSidebarNavGroupMaxHeight } from "./group-layout";

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
