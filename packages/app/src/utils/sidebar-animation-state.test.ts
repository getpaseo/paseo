import { describe, expect, it } from "vitest";
import {
  getLeftSidebarAnimationTargets,
  getRightSidebarAnimationTargets,
  shouldSyncSidebarAnimation,
} from "./sidebar-animation-state";

describe("sidebar-animation-state", () => {
  it("requests a sync when the open state changes", () => {
    expect(
      shouldSyncSidebarAnimation({
        previousIsOpen: false,
        nextIsOpen: true,
        previousWindowWidth: 390,
        nextWindowWidth: 390,
      }),
    ).toBe(true);
  });

  it("requests a sync when the viewport width changes", () => {
    expect(
      shouldSyncSidebarAnimation({
        previousIsOpen: false,
        nextIsOpen: false,
        previousWindowWidth: 390,
        nextWindowWidth: 430,
      }),
    ).toBe(true);
  });

  it("keeps the left sidebar fully off-screen when closed", () => {
    expect(getLeftSidebarAnimationTargets({ isOpen: false, windowWidth: 430 })).toEqual({
      translateX: -430,
      backdropOpacity: 0,
    });
  });

  it("keeps the right sidebar fully off-screen when closed", () => {
    expect(getRightSidebarAnimationTargets({ isOpen: false, windowWidth: 430 })).toEqual({
      translateX: 430,
      backdropOpacity: 0,
    });
  });
});
