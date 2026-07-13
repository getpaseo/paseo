import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarWorkspaceVisibilityStore } from "@/stores/sidebar-workspace-visibility-store";
import { resolveProjectPreferenceReconciliationKeys } from "./sidebar-project-preference-reconciliation";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

const allHostProjects = [
  { projectKey: "project-a", serverId: "host-a" },
  { projectKey: "project-b", serverId: "host-b" },
];

describe("project preference reconciliation", () => {
  beforeEach(() => {
    useSidebarViewStore.setState({ projectFilters: [] });
    useSidebarWorkspaceVisibilityStore.setState({ hiddenProjectKeys: [] });
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
    useSidebarViewStore.getState().toggleProjectFilter("project-b");
    useSidebarWorkspaceVisibilityStore.getState().setProjectHidden("project-b", true);
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
      useSidebarViewStore.getState().reconcileProjectFilters(allProjectKeys ?? []);
      useSidebarWorkspaceVisibilityStore.getState().reconcileProjectKeys(allProjectKeys ?? []);
    }

    expect(useSidebarViewStore.getState().projectFilters).toEqual(["project-b"]);
    expect(useSidebarWorkspaceVisibilityStore.getState().hiddenProjectKeys).toEqual(["project-b"]);
  });
});
