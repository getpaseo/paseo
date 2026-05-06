import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceRouteState } from "./workspace-route-state";

function createWorkspaceDescriptor(): WorkspaceDescriptor {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: "/repo/project",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "running",
    diffStat: null,
    scripts: [],
    archivingAt: null,
  };
}

describe("resolveWorkspaceRouteState", () => {
  it("returns unreachable when no descriptor is cached and the host is offline", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "offline",
        lastError: "transport closed",
        workspace: null,
        hasHydratedWorkspaces: false,
      }),
    ).toEqual({
      kind: "unreachable",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("keeps offline routes unreachable after workspace hydration", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "offline",
        lastError: "transport closed",
        workspace: null,
        hasHydratedWorkspaces: true,
      }),
    ).toEqual({
      kind: "unreachable",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("returns reconnecting when the descriptor is cached and the host is offline", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "offline",
        lastError: "transport closed",
        workspace: createWorkspaceDescriptor(),
        hasHydratedWorkspaces: true,
      }),
    ).toEqual({
      kind: "reconnecting",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("returns missing after workspace hydration when the host is online", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: null,
        hasHydratedWorkspaces: true,
      }),
    ).toEqual({ kind: "missing", hostName: "Laptop" });
  });

  it("returns loading before workspace hydration when the host is online", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: null,
        hasHydratedWorkspaces: false,
      }),
    ).toEqual({ kind: "loading", hostName: "Laptop" });
  });

  it("returns ready when the host is online and the descriptor exists", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: createWorkspaceDescriptor(),
        hasHydratedWorkspaces: true,
      }),
    ).toEqual({ kind: "ready" });
  });
});
