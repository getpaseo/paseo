import { beforeEach, describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createHistoryViewStore } from "@/stores/history-view-store";
import { resolveHistoryFilterReconciliation } from "./history-filter-reconciliation";

const storage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
const store = createHistoryViewStore(storage);

describe("History filter reconciliation", () => {
  beforeEach(() => {
    store.setState({
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
    expect(store.getState().hostFilters).toEqual(["host-b"]);
    expect(store.getState().projectFilters).toEqual(["project-b"]);

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
    store.getState().reconcileHostFilters(partialHydration?.hostKeys ?? []);
    expect(store.getState().hostFilters).toEqual(["host-b"]);
    expect(store.getState().projectFilters).toEqual(["project-b"]);

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
      store.getState().reconcileProjectFilters(completeHydration.projectKeys);
    }
    expect(store.getState().projectFilters).toEqual(["project-b"]);
  });
});
