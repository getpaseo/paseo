import type { DaemonClient } from "@server/client/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import {
  activateNavigationWorkspaceSelection,
  syncNavigationActiveWorkspace,
} from "@/stores/navigation-active-workspace-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";

const { replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
}));

vi.mock("expo-router", () => ({
  router: {
    replace: replaceMock,
  },
}));

function workspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project",
    projectRootPath: input.projectRootPath ?? "/repo",
    workspaceDirectory: input.workspaceDirectory ?? input.projectRootPath ?? "/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "worktree",
    name: input.name ?? input.id,
    status: input.status ?? "done",
    archivingAt: input.archivingAt ?? null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

describe("buildWorkspaceArchiveRedirectRoute", () => {
  it("redirects an archived worktree to the new workspace screen for the same project", () => {
    const workspaces = [
      workspace({ id: "/repo", workspaceKind: "checkout", name: "main" }),
      workspace({ id: "/repo/.paseo/worktrees/feature", name: "feature" }),
    ];

    expect(
      buildWorkspaceArchiveRedirectRoute({
        serverId: "server-1",
        archivedWorkspaceId: "/repo/.paseo/worktrees/feature",
        workspaces,
      }),
    ).toBe("/h/server-1/new?dir=%2Frepo&name=Project");
  });

  it("redirects to the new workspace route when no sibling workspace target exists", () => {
    const workspaces = [
      workspace({
        id: "/repo/.paseo/worktrees/feature",
        name: "feature",
        projectRootPath: "/repo",
      }),
    ];

    expect(
      buildWorkspaceArchiveRedirectRoute({
        serverId: "server-1",
        archivedWorkspaceId: "/repo/.paseo/worktrees/feature",
        workspaces,
      }),
    ).toBe("/h/server-1/new?dir=%2Frepo&name=Project");
  });

  it("redirects to the new workspace route instead of another workspace", () => {
    const workspaces = [
      workspace({
        id: "/notes",
        projectId: "notes",
        projectRootPath: "/notes",
        projectKind: "directory",
        workspaceKind: "checkout",
      }),
    ];

    expect(
      buildWorkspaceArchiveRedirectRoute({
        serverId: "server-1",
        archivedWorkspaceId: "/notes",
        workspaces,
      }),
    ).toBe("/h/server-1/new?dir=%2Fnotes&name=Project");
  });
});

describe("redirectIfArchivingActiveWorkspace", () => {
  afterEach(() => {
    replaceMock.mockClear();
    syncNavigationActiveWorkspace({ current: null });
    useSessionStore.getState().clearSession("server-1");
  });

  it("does not replace the route when archiving an inactive workspace", () => {
    useSessionStore.getState().initializeSession("server-1", null as unknown as DaemonClient);
    useSessionStore.getState().setWorkspaces(
      "server-1",
      new Map([
        ["main", workspace({ id: "main", workspaceKind: "local_checkout" })],
        ["feature", workspace({ id: "feature", name: "feature" })],
      ]),
    );
    activateNavigationWorkspaceSelection({ serverId: "server-1", workspaceId: "main" });

    expect(
      redirectIfArchivingActiveWorkspace({
        serverId: "server-1",
        workspaceId: "feature",
      }),
    ).toBe(false);

    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("replaces the route at action time when archiving the active workspace", () => {
    useSessionStore.getState().initializeSession("server-1", null as unknown as DaemonClient);
    useSessionStore.getState().setWorkspaces(
      "server-1",
      new Map([
        ["main", workspace({ id: "main", workspaceKind: "local_checkout" })],
        ["feature", workspace({ id: "feature", name: "feature" })],
      ]),
    );
    activateNavigationWorkspaceSelection({ serverId: "server-1", workspaceId: "feature" });

    expect(
      redirectIfArchivingActiveWorkspace({
        serverId: "server-1",
        workspaceId: "feature",
      }),
    ).toBe(true);

    expect(replaceMock).toHaveBeenCalledWith("/h/server-1/new?dir=%2Frepo&name=Project");
  });
});
