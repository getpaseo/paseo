import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHistoryViewStore } from "@/stores/history-view-store";
import { resolveHistoryFilterReconciliation } from "./history-filter-reconciliation";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("History filter reconciliation", () => {
  beforeEach(() => {
    useHistoryViewStore.setState({
      hostFilters: ["host-b"],
      projectFilters: ["project-b"],
    });
  });

  it("preserves persisted filters through cold-start hydration barriers", () => {
    const coldStart = resolveHistoryFilterReconciliation({
      preferencesHydrated: false,
      hostRegistryLoaded: false,
      allServerIds: [],
      hydratedServerIds: [],
      allHostProjects: [],
    });
    expect(coldStart).toBeNull();
    expect(useHistoryViewStore.getState().hostFilters).toEqual(["host-b"]);
    expect(useHistoryViewStore.getState().projectFilters).toEqual(["project-b"]);

    const partialHydration = resolveHistoryFilterReconciliation({
      preferencesHydrated: true,
      hostRegistryLoaded: true,
      allServerIds: ["host-a", "host-b"],
      hydratedServerIds: ["host-a"],
      allHostProjects: [{ projectKey: "project-a" }],
    });
    expect(partialHydration).toEqual({
      hostKeys: ["host-a", "host-b"],
      projectKeys: null,
    });
    useHistoryViewStore.getState().reconcileHostFilters(partialHydration?.hostKeys ?? []);
    expect(useHistoryViewStore.getState().hostFilters).toEqual(["host-b"]);
    expect(useHistoryViewStore.getState().projectFilters).toEqual(["project-b"]);

    const completeHydration = resolveHistoryFilterReconciliation({
      preferencesHydrated: true,
      hostRegistryLoaded: true,
      allServerIds: ["host-a", "host-b"],
      hydratedServerIds: ["host-a", "host-b"],
      allHostProjects: [{ projectKey: "project-a" }, { projectKey: "project-b" }],
    });
    expect(completeHydration).toEqual({
      hostKeys: ["host-a", "host-b"],
      projectKeys: ["project-a", "project-b"],
    });
    if (completeHydration?.projectKeys) {
      useHistoryViewStore.getState().reconcileProjectFilters(completeHydration.projectKeys);
    }
    expect(useHistoryViewStore.getState().projectFilters).toEqual(["project-b"]);
  });
});
