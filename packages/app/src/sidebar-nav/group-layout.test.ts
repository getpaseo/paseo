import { describe, expect, it } from "vitest";
import { SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT, resolveSidebarNavGroupMaxHeight } from "./group-layout";

describe("resolveSidebarNavGroupMaxHeight", () => {
  it("caps the group at a third of the window", () => {
    expect(resolveSidebarNavGroupMaxHeight(900)).toBe(300);
    expect(resolveSidebarNavGroupMaxHeight(1000)).toBe(333);
  });

  it("keeps room for a few rows on a short window", () => {
    expect(resolveSidebarNavGroupMaxHeight(200)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(287)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(288)).toBe(96);
    expect(resolveSidebarNavGroupMaxHeight(291)).toBe(97);
  });

  it("falls back to the floor when the window has no usable height yet", () => {
    expect(resolveSidebarNavGroupMaxHeight(0)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(Number.NaN)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(Number.POSITIVE_INFINITY)).toBe(
      SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT,
    );
  });
});
