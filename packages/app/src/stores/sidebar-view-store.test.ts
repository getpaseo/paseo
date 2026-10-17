import { beforeEach, describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createSidebarViewStorage,
  hasActiveSidebarLabelFilter,
  migrateSidebarViewState,
  SIDEBAR_UNLABELLED_LABEL_KEY,
  useSidebarViewStore,
} from "./sidebar-view-store";

interface MemoryStorage extends StateStorage<Promise<void>> {
  reads: string[];
}

function createMemoryStorage(entries: Record<string, string | null>): MemoryStorage {
  const reads: string[] = [];
  return {
    reads,
    getItem: async (name) => {
      reads.push(name);
      return entries[name] ?? null;
    },
    setItem: async (name, value) => {
      entries[name] = value;
    },
    removeItem: async (name) => {
      entries[name] = null;
    },
  };
}

describe("sidebar view store", () => {
  it("keeps manual ordering by default for fresh and existing installations", () => {
    expect(useSidebarViewStore.getInitialState()).toMatchObject({
      sortMode: "manual",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
    });
    expect(migrateSidebarViewState({}).sortMode).toBe("manual");
    expect(migrateSidebarViewState({ groupMode: "status", hostFilters: ["host-a"] })).toMatchObject(
      {
        sortMode: "manual",
        projectSortMode: "manual",
        workspaceActivityRunningFirst: false,
        projectActivityRunningFirst: false,
        groupMode: "status",
        hostFilters: ["host-a"],
      },
    );
  });
  it("preserves both levels for a saved activity preference from version 8", () => {
    expect(migrateSidebarViewState({ sortMode: "recent" })).toMatchObject({
      sortMode: "recent",
      projectSortMode: "recent",
    });
  });

  it("preserves an explicit activity choice alongside legacy grouping", () => {
    expect(
      migrateSidebarViewState({
        groupModeByServerId: { "host-a": "status" },
        sortMode: "recent",
        projectSortMode: "manual",
        workspaceActivityRunningFirst: false,
        projectActivityRunningFirst: false,
      }),
    ).toMatchObject({ groupMode: "status", sortMode: "recent", projectSortMode: "manual" });
  });

  it("persists independent project and workspace preferences", () => {
    for (const sortMode of ["manual", "name", "recent"] as const) {
      for (const projectSortMode of ["manual", "name", "recent"] as const) {
        expect(migrateSidebarViewState({ sortMode, projectSortMode })).toMatchObject({
          sortMode,
          projectSortMode,
        });
      }
    }
    const store = useSidebarViewStore.getState();
    store.setSortMode("recent");
    expect(useSidebarViewStore.getState()).toMatchObject({
      sortMode: "recent",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
    });
    store.setProjectSortMode("recent");
    store.setSortMode("manual");
    expect(useSidebarViewStore.getState()).toMatchObject({
      sortMode: "manual",
      projectSortMode: "recent",
    });
    store.setProjectSortMode("manual");
    expect(useSidebarViewStore.getState()).toMatchObject({
      sortMode: "manual",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
    });
  });

  it("stores running-first preferences independently and keeps them when sorting changes", () => {
    const store = useSidebarViewStore.getState();
    store.setWorkspaceActivityRunningFirst(true);
    store.setProjectActivityRunningFirst(false);
    store.setSortMode("name");
    expect(useSidebarViewStore.getState()).toMatchObject({
      workspaceActivityRunningFirst: true,
      projectActivityRunningFirst: false,
      sortMode: "name",
    });
    store.setSortMode("recent");
    store.setProjectActivityRunningFirst(true);
    expect(
      migrateSidebarViewState({
        sortMode: "recent",
        projectSortMode: "name",
        workspaceActivityRunningFirst: false,
        projectActivityRunningFirst: true,
      }),
    ).toMatchObject({
      sortMode: "recent",
      projectSortMode: "name",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: true,
    });
  });

  it("persists recent-activity sorting and allows manual order again", () => {
    useSidebarViewStore.getState().setSortMode("recent");
    expect(useSidebarViewStore.getState().sortMode).toBe("recent");
    expect(migrateSidebarViewState({ sortMode: "recent", groupMode: "project" }).sortMode).toBe(
      "recent",
    );
    useSidebarViewStore.getState().setSortMode("manual");
    expect(useSidebarViewStore.getState().sortMode).toBe("manual");
  });
  beforeEach(() => {
    useSidebarViewStore.setState({
      sortMode: "manual",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
      showBackground: false,
      groupMode: "project",
      hostFilters: [],
      projectFilters: [],
      labelFilter: { labels: [] },
    });
  });

  it("toggles multiple hosts into and out of the filter", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("host-b");

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a", "host-b"]);

    store.toggleHostFilter("host-a");

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-b"]);

    store.clearHostFilters();

    expect(useSidebarViewStore.getState().hostFilters).toEqual([]);
  });

  it("keeps host filters that still point at available hosts", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("host-b");

    store.reconcileHostFilters(["host-a", "host-b", "host-c"]);

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a", "host-b"]);
  });

  it("drops a host filter after that host is removed", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("removed-host");

    store.reconcileHostFilters(["host-a"]);

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a"]);
  });

  it("migrates legacy per-host group modes to the new global mode", () => {
    expect(
      migrateSidebarViewState({
        groupModeByServerId: {
          "host-a": "project",
          "host-b": "status",
        },
      }),
    ).toEqual({
      sortMode: "manual",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
      showBackground: false,
      groupMode: "status",
      hostFilters: [],
      projectFilters: [],
      labelFilter: { labels: [] },
    });
  });

  it("migrates a pre-v2 single host filter to the multi-host list", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "status",
        hostFilter: "host-a",
      }),
    ).toEqual({
      sortMode: "manual",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
      showBackground: false,
      groupMode: "status",
      hostFilters: ["host-a"],
      projectFilters: [],
      labelFilter: { labels: [] },
    });
  });

  it("keeps current persisted sidebar view state during version migration", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "status",
        hostFilters: ["host-a", "host-b"],
      }),
    ).toEqual({
      sortMode: "manual",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
      showBackground: false,
      groupMode: "status",
      hostFilters: ["host-a", "host-b"],
      projectFilters: [],
      labelFilter: { labels: [] },
    });
  });

  it("clears only the label facet", () => {
    useSidebarViewStore.setState({
      groupMode: "status",
      hostFilters: ["host-a"],
      labelFilter: { labels: ["urgent", "blocked"] },
    });

    useSidebarViewStore.getState().clearLabelFilter();

    expect(useSidebarViewStore.getState()).toMatchObject({
      groupMode: "status",
      hostFilters: ["host-a"],
      labelFilter: { labels: [] },
    });
  });

  it("toggles a label on and off under one normalized identity", () => {
    const { toggleLabelFilter } = useSidebarViewStore.getState();
    const labels = () => useSidebarViewStore.getState().labelFilter.labels;

    toggleLabelFilter("Urgent");
    expect(labels()).toEqual(["urgent"]);
    expect(hasActiveSidebarLabelFilter(useSidebarViewStore.getState().labelFilter)).toBe(true);

    toggleLabelFilter(" URGENT ");
    expect(labels()).toEqual([]);
    expect(hasActiveSidebarLabelFilter(useSidebarViewStore.getState().labelFilter)).toBe(false);
  });

  it("filters Unlabelled alongside real labels without colliding with one", () => {
    const { toggleLabelFilter } = useSidebarViewStore.getState();

    toggleLabelFilter(SIDEBAR_UNLABELLED_LABEL_KEY);
    toggleLabelFilter("Urgent");
    expect(useSidebarViewStore.getState().labelFilter).toEqual({
      labels: [SIDEBAR_UNLABELLED_LABEL_KEY, "urgent"],
    });
  });

  it("drops deleted labels from the active filter but retains Unlabelled", () => {
    useSidebarViewStore.setState({
      labelFilter: { labels: [SIDEBAR_UNLABELLED_LABEL_KEY, "urgent", "removed"] },
    });

    useSidebarViewStore.getState().reconcileLabelFilter(["Urgent"]);

    expect(useSidebarViewStore.getState().labelFilter).toEqual({
      labels: [SIDEBAR_UNLABELLED_LABEL_KEY, "urgent"],
    });
  });

  it("re-keys a persisted label filter through the normalized identity, without duplicates", () => {
    expect(
      migrateSidebarViewState({
        labelFilter: { labels: [" Urgent ", "BLOCKED", "urgent"], match: "all" },
      }).labelFilter,
    ).toEqual({ labels: ["urgent", "blocked"] });
  });

  it("toggles multiple projects into and out of the filter", () => {
    const store = useSidebarViewStore.getState();
    store.toggleProjectFilter("project-a");
    store.toggleProjectFilter("project-b");

    expect(useSidebarViewStore.getState().projectFilters).toEqual(["project-a", "project-b"]);

    store.toggleProjectFilter("project-a");

    expect(useSidebarViewStore.getState().projectFilters).toEqual(["project-b"]);

    store.clearProjectFilters();

    expect(useSidebarViewStore.getState().projectFilters).toEqual([]);
  });

  it("keeps the other facets when the project filter is cleared", () => {
    useSidebarViewStore.setState({
      groupMode: "status",
      hostFilters: ["host-a"],
      projectFilters: ["project-a"],
      labelFilter: { labels: ["urgent"] },
    });

    useSidebarViewStore.getState().clearProjectFilters();

    expect(useSidebarViewStore.getState()).toMatchObject({
      groupMode: "status",
      hostFilters: ["host-a"],
      projectFilters: [],
      labelFilter: { labels: ["urgent"] },
    });
  });

  // The persisted schema is a `z.strictObject` behind `createValidatedPersistStorage`, so a key
  // the schema does not list fails the parse and takes every other sidebar setting down with it.
  it("carries a persisted project filter through the version migration", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "project",
        hostFilters: ["host-a"],
        projectFilters: ["project-a", "project-b"],
      }),
    ).toEqual({
      sortMode: "manual",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
      showBackground: false,
      groupMode: "project",
      hostFilters: ["host-a"],
      projectFilters: ["project-a", "project-b"],
      labelFilter: { labels: [] },
    });
  });

  it("never keeps project filters from state the schema rejects", () => {
    expect(migrateSidebarViewState({ projectFilters: "project-a" })).toEqual({
      sortMode: "manual",
      projectSortMode: "manual",
      workspaceActivityRunningFirst: false,
      projectActivityRunningFirst: false,
      showBackground: false,
      groupMode: "project",
      hostFilters: [],
      projectFilters: [],
      labelFilter: { labels: [] },
    });
  });

  it("falls back to the legacy storage key when the new key is empty", async () => {
    const storage = createMemoryStorage({
      "sidebar-view": null,
      "sidebar-group-mode": JSON.stringify({
        state: { groupModeByServerId: { "host-a": "status" } },
        version: 0,
      }),
    });

    const value = await createSidebarViewStorage(storage).getItem("sidebar-view");

    expect(value).toBe(
      JSON.stringify({
        state: { groupModeByServerId: { "host-a": "status" } },
        version: 0,
      }),
    );
    expect(storage.reads).toEqual(["sidebar-view", "sidebar-group-mode"]);
  });

  it("uses the new storage key without reading the legacy key when current state exists", async () => {
    const storage = createMemoryStorage({
      "sidebar-view": JSON.stringify({
        state: { groupMode: "project", hostFilters: ["host-a"] },
        version: 2,
      }),
      "sidebar-group-mode": JSON.stringify({
        state: { groupModeByServerId: { "host-b": "status" } },
        version: 0,
      }),
    });

    const value = await createSidebarViewStorage(storage).getItem("sidebar-view");

    expect(value).toBe(
      JSON.stringify({
        state: { groupMode: "project", hostFilters: ["host-a"] },
        version: 2,
      }),
    );
    expect(storage.reads).toEqual(["sidebar-view"]);
  });
});
