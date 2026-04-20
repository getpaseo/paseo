import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceSetupStore } from "./workspace-setup-store";

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
});
