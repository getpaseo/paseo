import { beforeEach, describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createSidebarViewStore } from "@/stores/sidebar-view-store";
import { createSidebarWorkspaceVisibilityStore } from "@/stores/sidebar-workspace-visibility-store";
import { resolveProjectPreferenceReconciliationKeys } from "./sidebar-project-preference-reconciliation";

const storage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
const sidebarViewStore = createSidebarViewStore(storage);
const visibilityStore = createSidebarWorkspaceVisibilityStore(storage);

const allHostProjects = [
  { projectKey: "project-a", serverId: "host-a" },
  { projectKey: "project-b", serverId: "host-b" },
];

describe("project preference reconciliation", () => {
  beforeEach(() => {
    sidebarViewStore.setState({ projectFilters: [] });
    visibilityStore.setState({ hiddenProjectKeys: [] });
  });

  it("waits until every registered host has hydrated", () => {
    expect(
      resolveProjectPreferenceReconciliationKeys({
        hostRegistryLoaded: true,
        allServerIds: ["host-a", "host-b"],
        hydratedServerIds: ["host-a"],
        allHostProjects,
      }),
    ).toBeNull();
  });

  it("preserves host-B filter and hidden preferences while switching host filters", () => {
    sidebarViewStore.getState().toggleProjectFilter("project-b");
    visibilityStore.getState().setProjectHidden("project-b", true);
    const allProjectKeys = resolveProjectPreferenceReconciliationKeys({
      hostRegistryLoaded: true,
      allServerIds: ["host-a", "host-b"],
      hydratedServerIds: ["host-a", "host-b"],
      allHostProjects,
    });
    expect(allProjectKeys).toEqual(["project-a", "project-b"]);

    for (const selectedHost of ["host-a", "host-b"]) {
      const visibleProjects = allHostProjects.filter(
        (project) => project.serverId === selectedHost,
      );
      expect(visibleProjects).toHaveLength(1);
      sidebarViewStore.getState().reconcileProjectFilters(allProjectKeys ?? []);
      visibilityStore.getState().reconcileProjectKeys(allProjectKeys ?? []);
    }

    expect(sidebarViewStore.getState().projectFilters).toEqual(["project-b"]);
    expect(visibilityStore.getState().hiddenProjectKeys).toEqual(["project-b"]);
  });
});
