import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { resolveNewWorkspaceInitialServerId } from "./new-workspace-initial-context";

function projectFor(serverId: string, key = "project"): HostProjectListItem {
  return {
    projectKey: key,
    projectName: key,
    projectKind: "git",
    iconWorkingDir: `/work/${key}`,
    hosts: [{ serverId, iconWorkingDir: `/work/${key}`, canCreateWorktree: true }],
    workspaceKeys: [],
  };
}

function statuses(
  entries: Record<string, HostRuntimeConnectionStatus>,
): ReadonlyMap<string, HostRuntimeConnectionStatus> {
  return new Map(Object.entries(entries));
}

function multiplicity(entries: Record<string, boolean> = {}): ReadonlyMap<string, boolean> {
  return new Map(Object.entries(entries));
}

describe("resolveNewWorkspaceInitialServerId", () => {
  it("prefers explicit route host context over online-host fallback", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "online"],
        routeServerId: "offline",
        lastActiveProject: null,
        projects: [projectFor("online")],
        hostConnectionStatusByServerId: statuses({ offline: "offline", online: "online" }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("offline");
  });

  it("uses a resolved last-active project but not a stale raw workspace host", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "online"],
        routeServerId: null,
        lastActiveProject: projectFor("offline"),
        projects: [projectFor("online")],
        hostConnectionStatusByServerId: statuses({ offline: "offline", online: "online" }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("offline");

    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "online"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("online")],
        hostConnectionStatusByServerId: statuses({ offline: "offline", online: "online" }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("online");
  });

  it("falls back to the only online host even before projects have hydrated", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline-a", "online", "offline-b"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [],
        hostConnectionStatusByServerId: statuses({
          "offline-a": "offline",
          online: "online",
          "offline-b": "offline",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("online");
  });

  it("uses the only host with selectable projects even before runtime status is online", () => {
    expect(
      resolveNewWorkspaceInitialServerId({
        allServerIds: ["offline", "connected"],
        routeServerId: null,
        lastActiveProject: null,
        projects: [projectFor("connected")],
        hostConnectionStatusByServerId: statuses({
          offline: "offline",
          connected: "connecting",
        }),
        workspaceMultiplicityByServerId: multiplicity(),
      }),
    ).toBe("connected");
  });
});
