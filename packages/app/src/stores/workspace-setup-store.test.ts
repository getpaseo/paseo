import { beforeEach, describe, expect, it } from "vitest";
import {
  shouldSeedWorkspaceSetupTab,
  shouldShowWorkspaceSetup,
  useWorkspaceSetupStore,
} from "./workspace-setup-store";

describe("workspace-setup-store", () => {
  beforeEach(() => {
    useWorkspaceSetupStore.setState({
      pendingWorkspaceSetup: null,
      snapshots: {},
      surfacedFailedSetupKeys: new Set(),
    });
  });

  it("tracks deferred workspace setup by source directory and optional workspace id", () => {
    useWorkspaceSetupStore.getState().beginWorkspaceSetup({
      serverId: "server-1",
      sourceDirectory: "/Users/test/project",
      sourceWorkspaceId: "42",
      displayName: "project",
      creationMethod: "open_project",
    });

    expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toEqual({
      serverId: "server-1",
      sourceDirectory: "/Users/test/project",
      sourceWorkspaceId: "42",
      displayName: "project",
      creationMethod: "open_project",
      creationId: expect.any(String),
      worktreeSlug: expect.any(String),
    });
  });

  it("clears pending setup state", () => {
    useWorkspaceSetupStore.getState().beginWorkspaceSetup({
      serverId: "server-1",
      sourceDirectory: "/Users/test/project",
      creationMethod: "create_worktree",
    });

    useWorkspaceSetupStore.getState().clearWorkspaceSetup();

    expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toBeNull();
  });

  it("uses directory metadata to surface failures without requesting setup details", () => {
    for (const status of [null, "running", "completed", "failed", "blocked"] as const) {
      expect(shouldShowWorkspaceSetup(status)).toBe(status !== null);
      expect(shouldSeedWorkspaceSetupTab(status)).toBe(status === "failed" || status === "blocked");
    }
    expect(shouldShowWorkspaceSetup(null, false)).toBe(true);
    const identity = { serverId: "server-1", workspaceId: "42", status: "failed" as const };
    expect(useWorkspaceSetupStore.getState().snapshots).toEqual({});
    expect(useWorkspaceSetupStore.getState().claimFailedSetupSurface(identity)).toBe(true);
    expect(useWorkspaceSetupStore.getState().claimFailedSetupSurface(identity)).toBe(false);
    useWorkspaceSetupStore.getState().applySetupStatus({ ...identity, status: "running" });
    expect(useWorkspaceSetupStore.getState().claimFailedSetupSurface(identity)).toBe(true);
    expect(useWorkspaceSetupStore.getState().snapshots).toEqual({});
  });
  it("replaces cached setup details with an empty reconnect snapshot", () => {
    const identity = { serverId: "server", workspaceId: "workspace" };
    const store = useWorkspaceSetupStore.getState();
    store.applySnapshot({
      ...identity,
      snapshot: {
        status: "failed",
        error: "previous setup failed",
        detail: {
          type: "worktree_setup",
          worktreePath: "/workspace",
          branchName: "main",
          commands: [],
          log: "previous output",
        },
      },
    });
    expect(Object.values(useWorkspaceSetupStore.getState().snapshots)).toHaveLength(1);
    store.applySnapshot({ ...identity, snapshot: null });
    expect(useWorkspaceSetupStore.getState().snapshots).toEqual({});
  });
});
