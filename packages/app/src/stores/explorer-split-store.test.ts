import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  EXPLORER_SPLIT_STORAGE_KEY,
  canShowExplorerTabBelow,
  clampExplorerSplitRatio,
  clampExplorerSplitRatioToHeight,
  createExplorerSplitStore,
  deriveExplorerSplitView,
  explorerSplitFitsHeight,
  nextEligibleExplorerTabId,
  selectExplorerActiveHalf,
  toggleExplorerSplit,
} from "./explorer-split-store";

function createMemoryStorage(entries: Record<string, string | null> = {}): StateStorage {
  return {
    getItem: (name) => entries[name] ?? null,
    setItem: (name, value) => {
      entries[name] = value;
    },
    removeItem: (name) => {
      entries[name] = null;
    },
  };
}

function tab(tabId: string, kind: "terminal" | "files" | "new_tab" = "terminal") {
  const targets = {
    terminal: { kind: "terminal" as const, terminalId: tabId },
    files: { kind: "files" as const },
    new_tab: { kind: "new_tab" as const },
  };
  const target = targets[kind];
  const descriptor: WorkspaceTabDescriptor = { key: tabId, tabId, kind, target };
  return descriptor;
}

const workspaceKey = "server:workspace";

describe("explorer split store", () => {
  it("shows a tab below with the default ratio and makes the top half active", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();
    store.getState().setActiveHalf(workspaceKey, "bottom");

    store.getState().showBelow(workspaceKey, tab("t2"));

    expect(store.getState().entries[workspaceKey]).toEqual({ lowerTabId: "t2", ratio: 0.5 });
    expect(selectExplorerActiveHalf(store.getState(), workspaceKey)).toBe("top");
  });

  it("writes nothing when the requested half is already active", async () => {
    let writes = 0;
    const memory = createMemoryStorage();
    const store = createExplorerSplitStore({
      ...memory,
      setItem: (name, value) => {
        writes += 1;
        return memory.setItem(name, value);
      },
    });
    await store.persist.rehydrate();
    const writesBefore = writes;

    store.getState().setActiveHalf(workspaceKey, "top");

    expect(writes).toBe(writesBefore);
  });

  it("keeps the divider position when a different tab is shown below", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();
    store.getState().showBelow(workspaceKey, tab("t2"));
    store.getState().setRatio(workspaceKey, 0.3);

    store.getState().showBelow(workspaceKey, tab("t3"));

    expect(store.getState().entries[workspaceKey]).toEqual({ lowerTabId: "t3", ratio: 0.3 });
  });

  it("refuses to show a launcher below", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();

    expect(() => store.getState().showBelow(workspaceKey, tab("launcher", "new_tab"))).toThrow(
      "A launcher tab can't be shown below in the Explorer: launcher",
    );
    expect(store.getState().entries[workspaceKey]).toBeUndefined();
  });

  it("ignores an empty workspace key", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();

    store.getState().showBelow("", tab("t2"));

    expect(store.getState().entries).toEqual({});
  });

  it("unsplits by removing the workspace's entry and resetting the active half", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();
    store.getState().showBelow(workspaceKey, tab("t2"));
    store.getState().setActiveHalf(workspaceKey, "bottom");

    store.getState().unsplit(workspaceKey);

    expect(store.getState().entries[workspaceKey]).toBeUndefined();
    expect(selectExplorerActiveHalf(store.getState(), workspaceKey)).toBe("top");
  });

  it("swaps the bottom tab and makes the top half active", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();
    store.getState().showBelow(workspaceKey, tab("t2"));
    store.getState().setRatio(workspaceKey, 0.4);
    store.getState().setActiveHalf(workspaceKey, "bottom");

    store.getState().swap(workspaceKey, "t1");

    expect(store.getState().entries[workspaceKey]).toEqual({ lowerTabId: "t1", ratio: 0.4 });
    expect(selectExplorerActiveHalf(store.getState(), workspaceKey)).toBe("top");
  });

  it("stores a clamped ratio and ignores a ratio for a workspace with no split", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();
    store.getState().setRatio(workspaceKey, 0.3);
    expect(store.getState().entries[workspaceKey]).toBeUndefined();
    store.getState().showBelow(workspaceKey, tab("t2"));

    store.getState().setRatio(workspaceKey, 0.97);

    expect(store.getState().entries[workspaceKey]?.ratio).toBe(0.9);
  });

  it("restores the split and divider after a reload, but not the active half", async () => {
    const storage = createMemoryStorage();
    const store = createExplorerSplitStore(storage);
    await store.persist.rehydrate();
    store.getState().showBelow(workspaceKey, tab("t2"));
    store.getState().setRatio(workspaceKey, 0.35);
    store.getState().setActiveHalf(workspaceKey, "bottom");

    const restored = createExplorerSplitStore(storage);
    await restored.persist.rehydrate();

    expect(restored.getState().entries[workspaceKey]).toEqual({ lowerTabId: "t2", ratio: 0.35 });
    expect(selectExplorerActiveHalf(restored.getState(), workspaceKey)).toBe("top");
  });

  it("drops a stored value with the wrong shape and starts with no split", async () => {
    const entries: Record<string, string | null> = {
      [EXPLORER_SPLIT_STORAGE_KEY]: JSON.stringify({
        state: { entries: { [workspaceKey]: { lowerTabId: 7, ratio: "half" } } },
        version: 1,
      }),
    };
    const store = createExplorerSplitStore(createMemoryStorage(entries));

    await store.persist.rehydrate();

    expect(store.getState().entries).toEqual({});
    expect(entries[EXPLORER_SPLIT_STORAGE_KEY]).toBeNull();
  });

  it("clamps an out-of-range stored ratio instead of dropping the stored splits", async () => {
    const entries: Record<string, string | null> = {
      [EXPLORER_SPLIT_STORAGE_KEY]: JSON.stringify({
        state: { entries: { [workspaceKey]: { lowerTabId: "t2", ratio: 4 } } },
        version: 1,
      }),
    };
    const store = createExplorerSplitStore(createMemoryStorage(entries));

    await store.persist.rehydrate();

    expect(store.getState().entries[workspaceKey]).toEqual({ lowerTabId: "t2", ratio: 0.9 });
  });
});

describe("clampExplorerSplitRatio", () => {
  it("falls back to an even split for zero and non-finite ratios", () => {
    expect(clampExplorerSplitRatio(0)).toBe(0.5);
    expect(clampExplorerSplitRatio(Number.NaN)).toBe(0.5);
    expect(clampExplorerSplitRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
  });

  it("keeps the ratio between 0.1 and 0.9", () => {
    expect(clampExplorerSplitRatio(-1)).toBe(0.1);
    expect(clampExplorerSplitRatio(0.05)).toBe(0.1);
    expect(clampExplorerSplitRatio(0.42)).toBe(0.42);
    expect(clampExplorerSplitRatio(0.95)).toBe(0.9);
  });
});

describe("clampExplorerSplitRatioToHeight", () => {
  it("keeps at least 80 points of content in each half, below the header", () => {
    expect(clampExplorerSplitRatioToHeight(0.1, 400, 28)).toBe(0.2);
    expect(clampExplorerSplitRatioToHeight(0.9, 400, 28)).toBe(0.73);
    expect(clampExplorerSplitRatioToHeight(0.5, 400, 28)).toBe(0.5);
  });

  it("splits only when the dock fits two minimum halves and the header", () => {
    expect(explorerSplitFitsHeight(188, 28)).toBe(true);
    expect(explorerSplitFitsHeight(187, 28)).toBe(false);
  });
});

describe("nextEligibleExplorerTabId", () => {
  it("picks the next tab after the active one, wrapping around", () => {
    const tabs = [tab("files", "files"), tab("t1"), tab("t2")];

    expect(nextEligibleExplorerTabId(tabs, "t1")).toBe("t2");
    expect(nextEligibleExplorerTabId(tabs, "t2")).toBe("files");
  });

  it("skips launchers and finds nothing when no other tab is eligible", () => {
    expect(nextEligibleExplorerTabId([tab("t1"), tab("launcher", "new_tab")], "t1")).toBeNull();
    expect(nextEligibleExplorerTabId([tab("launcher", "new_tab"), tab("t1")], "launcher")).toBe(
      "t1",
    );
  });
});

describe("canShowExplorerTabBelow", () => {
  it("offers Show below only for an eligible tab that is in neither half", () => {
    expect(canShowExplorerTabBelow(tab("t3"), "t1", "t2")).toBe(true);
    expect(canShowExplorerTabBelow(tab("t1"), "t1", "t2")).toBe(false);
    expect(canShowExplorerTabBelow(tab("t2"), "t1", "t2")).toBe(false);
    expect(canShowExplorerTabBelow(tab("launcher", "new_tab"), "t1", null)).toBe(false);
  });
});

describe("deriveExplorerSplitView", () => {
  const tabs = [tab("files", "files"), tab("t1"), tab("t2"), tab("launcher", "new_tab")];

  it("shows one tab outside the desktop layout and keeps the saved split", () => {
    expect(
      deriveExplorerSplitView({
        explorerTabs: tabs,
        activeTabId: "t1",
        lowerTabId: "t2",
        lastTopTabId: null,
        layoutMode: "compact",
      }),
    ).toEqual({ kind: "single", reason: "mode" });
  });

  it("shows one tab when nothing is shown below", () => {
    expect(
      deriveExplorerSplitView({
        explorerTabs: tabs,
        activeTabId: "t1",
        lowerTabId: null,
        lastTopTabId: null,
        layoutMode: "split-panes",
      }),
    ).toEqual({ kind: "single", reason: "none" });
  });

  it("ends the split when the bottom tab left the Explorer or is a launcher", () => {
    expect(
      deriveExplorerSplitView({
        explorerTabs: tabs,
        activeTabId: "t1",
        lowerTabId: "closed",
        lastTopTabId: "t1",
        layoutMode: "split-panes",
      }),
    ).toEqual({ kind: "single", reason: "missing" });
    expect(
      deriveExplorerSplitView({
        explorerTabs: tabs,
        activeTabId: "t1",
        lowerTabId: "launcher",
        lastTopTabId: "t1",
        layoutMode: "split-panes",
      }),
    ).toEqual({ kind: "single", reason: "missing" });
  });

  it("shows the active tab on top and the stored tab below", () => {
    expect(
      deriveExplorerSplitView({
        explorerTabs: tabs,
        activeTabId: "t1",
        lowerTabId: "t2",
        lastTopTabId: "files",
        layoutMode: "split-panes",
      }),
    ).toEqual({ kind: "split", topTabId: "t1", lowerTabId: "t2" });
  });

  it("swaps in one step when the bottom tab becomes active by a click or a reveal", () => {
    expect(
      deriveExplorerSplitView({
        explorerTabs: tabs,
        activeTabId: "t2",
        lowerTabId: "t2",
        lastTopTabId: "t1",
        layoutMode: "split-panes",
      }),
    ).toEqual({ kind: "split", topTabId: "t2", lowerTabId: "t1" });
  });

  it("ends the split when the bottom tab becomes active after the top tab was closed", () => {
    expect(
      deriveExplorerSplitView({
        explorerTabs: [tab("t2"), tab("t3")],
        activeTabId: "t2",
        lowerTabId: "t2",
        lastTopTabId: "files",
        layoutMode: "split-panes",
      }),
    ).toEqual({ kind: "single", reason: "ended" });
  });

  it("keeps the split when closing or moving the top tab focuses a tab other than the bottom one", () => {
    expect(
      deriveExplorerSplitView({
        explorerTabs: [tab("t1"), tab("t2"), tab("t3")],
        activeTabId: "t3",
        lowerTabId: "t2",
        lastTopTabId: "files",
        layoutMode: "split-panes",
      }),
    ).toEqual({ kind: "split", topTabId: "t3", lowerTabId: "t2" });
  });

  it("ends the split after a reload whose focused tab is the saved bottom tab", () => {
    expect(
      deriveExplorerSplitView({
        explorerTabs: tabs,
        activeTabId: "t2",
        lowerTabId: "t2",
        lastTopTabId: null,
        layoutMode: "split-panes",
      }),
    ).toEqual({ kind: "single", reason: "ended" });
  });
});

describe("toggleExplorerSplit", () => {
  it("shows the next eligible tab below when the Explorer is not split", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();

    toggleExplorerSplit(
      {
        workspaceKey,
        explorerTabs: [tab("files", "files"), tab("t1"), tab("t2")],
        activeTabId: "t1",
      },
      store,
    );

    expect(store.getState().entries[workspaceKey]?.lowerTabId).toBe("t2");
  });

  it("unsplits when the Explorer is split", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();
    store.getState().showBelow(workspaceKey, tab("t2"));

    toggleExplorerSplit(
      { workspaceKey, explorerTabs: [tab("t1"), tab("t2")], activeTabId: "t1" },
      store,
    );

    expect(store.getState().entries[workspaceKey]).toBeUndefined();
  });

  it("does nothing when no other tab can be shown below", async () => {
    const store = createExplorerSplitStore(createMemoryStorage());
    await store.persist.rehydrate();

    toggleExplorerSplit(
      { workspaceKey, explorerTabs: [tab("t1"), tab("launcher", "new_tab")], activeTabId: "t1" },
      store,
    );

    expect(store.getState().entries).toEqual({});
  });
});
