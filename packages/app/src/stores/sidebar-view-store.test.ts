import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import { useSidebarViewStore } from "@/stores/sidebar-view-store";

describe("sidebar-view-store", () => {
  beforeEach(() => {
    useSidebarViewStore.setState({
      groupModeByServerId: {},
      embeddedTabSortModeByServerId: {},
      embeddedRecentTabCountByServerId: {},
    });
  });

  it("normalizes embedded tab preferences loaded from persisted state", () => {
    useSidebarViewStore.setState({
      embeddedTabSortModeByServerId: { srv: "bad-value" as never },
      embeddedRecentTabCountByServerId: { srv: 99 as never },
    });

    expect(useSidebarViewStore.getState().getEmbeddedTabSortMode("srv")).toBe("manual");
    expect(useSidebarViewStore.getState().getEmbeddedRecentTabCount("srv")).toBe(5);
  });

  it("trims server ids before storing embedded tab preferences", () => {
    useSidebarViewStore.getState().setEmbeddedTabSortMode("  srv  ", "lastUpdated");
    useSidebarViewStore.getState().setEmbeddedRecentTabCount("  srv  ", "all");

    expect(useSidebarViewStore.getState().embeddedTabSortModeByServerId).toEqual({
      srv: "lastUpdated",
    });
    expect(useSidebarViewStore.getState().embeddedRecentTabCountByServerId).toEqual({
      srv: "all",
    });
  });
});
