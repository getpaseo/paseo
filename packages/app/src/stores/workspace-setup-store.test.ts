import { beforeEach, describe, expect, it } from "vitest";
import { shouldShowWorkspaceSetup, useWorkspaceSetupStore } from "./workspace-setup-store";

describe("workspace-setup-store", () => {
  beforeEach(() => {
    useWorkspaceSetupStore.setState({ pendingWorkspaceSetup: null });
  });

  it("tracks deferred workspace setup by source directory and optional workspace id", () => {
    useWorkspaceSetupStore.getState().beginWorkspaceSetup({
      serverId: "server-1",
      sourceDirectory: "/Users/test/project",
      sourceWorkspaceId: "42",
      displayName: "project",
      creationMethod: "open_project",
      navigationMethod: "replace",
    });

    expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toEqual({
      serverId: "server-1",
      sourceDirectory: "/Users/test/project",
      sourceWorkspaceId: "42",
      displayName: "project",
      creationMethod: "open_project",
      navigationMethod: "replace",
    });
  });

  it("clears pending setup state", () => {
    useWorkspaceSetupStore.getState().beginWorkspaceSetup({
      serverId: "server-1",
      sourceDirectory: "/Users/test/project",
      creationMethod: "create_worktree",
      navigationMethod: "navigate",
    });

    useWorkspaceSetupStore.getState().clearWorkspaceSetup();

    expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toBeNull();
  });

  it("hides empty successful setup snapshots", () => {
    expect(
      shouldShowWorkspaceSetup({
        workspaceId: "workspace-1",
        status: "completed",
        detail: {
          type: "worktree_setup",
          worktreePath: "/Users/test/project",
          branchName: "main",
          log: "",
          commands: [],
        },
        error: null,
        updatedAt: Date.now(),
      }),
    ).toBe(false);
  });

  it("shows setup snapshots with commands or errors", () => {
    expect(
      shouldShowWorkspaceSetup({
        workspaceId: "workspace-1",
        status: "completed",
        detail: {
          type: "worktree_setup",
          worktreePath: "/Users/test/project",
          branchName: "main",
          log: "done\n",
          commands: [
            {
              index: 1,
              command: "npm install",
              cwd: "/Users/test/project",
              log: "done\n",
              status: "completed",
              exitCode: 0,
            },
          ],
        },
        error: null,
        updatedAt: Date.now(),
      }),
    ).toBe(true);

    expect(
      shouldShowWorkspaceSetup({
        workspaceId: "workspace-1",
        status: "failed",
        detail: {
          type: "worktree_setup",
          worktreePath: "/Users/test/project",
          branchName: "main",
          log: "",
          commands: [],
        },
        error: "Failed to parse paseo.json",
        updatedAt: Date.now(),
      }),
    ).toBe(true);
  });
});
