import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { StateStorage } from "zustand/middleware";
import {
  createSidebarViewStorage,
  hasActiveSidebarLabelFilter,
  migrateSidebarViewState,
  SIDEBAR_UNLABELLED_LABEL_KEY,
  useSidebarViewStore,
} from "./sidebar-view-store";
import {
  applyWorkspacePinGroupCatalog,
  workspacePinGroupsQueryKey,
} from "@/workspace-pin-groups/catalog";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

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
  beforeEach(() => {
    useSidebarViewStore.setState({
      groupMode: "project",
      activePinGroup: null,
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

  it("clears an active pin group only after its owning host is removed", () => {
    const store = useSidebarViewStore.getState();
    store.setActivePinGroup({ serverId: "host-a", groupId: "default" });

    store.reconcileHostFilters(["host-a", "host-b"]);
    expect(useSidebarViewStore.getState()).toMatchObject({
      activePinGroup: { serverId: "host-a", groupId: "default" },
    });

    store.reconcileHostFilters(["host-b"]);
    expect(useSidebarViewStore.getState()).toMatchObject({
      activePinGroup: null,
    });
  });

  it("falls back to the same host's default when the active group is removed", () => {
    const store = useSidebarViewStore.getState();
    store.setActivePinGroup({ serverId: "host-a", groupId: "team" });

    store.reconcilePinGroups("host-a", ["default", "review"]);

    expect(useSidebarViewStore.getState().activePinGroup).toEqual({
      serverId: "host-a",
      groupId: "default",
    });
  });

  it("applies a pushed host-local catalog and reconciles a removed group", () => {
    const queryClient = new QueryClient();
    useSidebarViewStore.getState().setActivePinGroup({ serverId: "host-a", groupId: "removed" });
    const pinGroups = [
      { id: "default", name: "Pinned", createdAt: "2026-01-01T00:00:00Z" },
      { id: "review", name: "Review", createdAt: "2026-02-01T00:00:00Z" },
    ];

    applyWorkspacePinGroupCatalog({ queryClient, serverId: "host-a", pinGroups });

    expect(queryClient.getQueryData(workspacePinGroupsQueryKey("host-a"))).toEqual(pinGroups);
    expect(useSidebarViewStore.getState().activePinGroup).toEqual({
      serverId: "host-a",
      groupId: "default",
    });
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
      groupMode: "status",
      activePinGroup: null,
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
      groupMode: "status",
      activePinGroup: null,
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
      groupMode: "status",
      activePinGroup: null,
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
      groupMode: "project",
      activePinGroup: null,
      hostFilters: ["host-a"],
      projectFilters: ["project-a", "project-b"],
      labelFilter: { labels: [] },
    });
  });

  it("never keeps project filters from state the schema rejects", () => {
    expect(migrateSidebarViewState({ projectFilters: "project-a" })).toEqual({
      groupMode: "project",
      activePinGroup: null,
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

  it("leaves legacy state without a cross-host default selection", () => {
    expect(migrateSidebarViewState({ groupMode: "status" }).activePinGroup).toBeNull();
  });

  it("persists and normalizes a host-scoped active pin group", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "project",
        activePinGroup: { groupId: " team ", serverId: " host-a " },
      }),
    ).toMatchObject({
      activePinGroup: { groupId: "team", serverId: "host-a" },
    });

    expect(
      migrateSidebarViewState({ groupMode: "project", activePinGroupId: "team" }),
    ).toMatchObject({ activePinGroup: null });

    useSidebarViewStore.getState().setActivePinGroup({ groupId: " review ", serverId: " host-a " });
    expect(useSidebarViewStore.getState()).toMatchObject({
      activePinGroup: { groupId: "review", serverId: "host-a" },
    });

    useSidebarViewStore.getState().setActivePinGroup({ groupId: " ", serverId: "host-a" });
    expect(useSidebarViewStore.getState()).toMatchObject({
      activePinGroup: null,
    });
  });

  it("migrates the v8 parallel fields including a server-scoped default", () => {
    expect(
      migrateSidebarViewState({
        activePinGroupId: "default",
        activePinGroupServerId: "host-a",
      }).activePinGroup,
    ).toEqual({ groupId: "default", serverId: "host-a" });
  });

  it("includes the active pin group scope in persisted device state", () => {
    useSidebarViewStore.getState().setActivePinGroup({ groupId: "team", serverId: "host-a" });

    const partialize = useSidebarViewStore.persist.getOptions().partialize;

    expect(partialize?.(useSidebarViewStore.getState())).toMatchObject({
      activePinGroup: { groupId: "team", serverId: "host-a" },
    });
  });
});
