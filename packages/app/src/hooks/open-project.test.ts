import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { addExistingWorkspaceDirectly } from "./open-project";

function workspace(path: string): WorkspaceDescriptorPayload {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: path,
    workspaceDirectory: path,
    projectKind: "git",
    workspaceKind: "worktree",
    name: "feature",
    title: "feature",
    status: "done",
    activityAt: null,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("addExistingWorkspaceDirectly", () => {
  it("registers a directory-backed workspace returned by the daemon", async () => {
    const mergeWorkspaces = vi.fn();
    const setHasHydratedWorkspaces = vi.fn();
    const createWorkspace = vi.fn().mockResolvedValue({
      workspace: workspace("/repo/feature"),
      setupTerminalId: null,
      error: null,
      requestId: "request-1",
    });

    const result = await addExistingWorkspaceDirectly({
      serverId: " server-1 ",
      workspacePath: " /repo/feature ",
      isConnected: true,
      client: { createWorkspace },
      mergeWorkspaces,
      setHasHydratedWorkspaces,
    });

    expect(createWorkspace).toHaveBeenCalledWith({
      source: { kind: "directory", path: "/repo/feature" },
    });
    expect(result).toMatchObject({ ok: true, workspace: { id: "workspace-1" } });
    expect(mergeWorkspaces).toHaveBeenCalledWith("server-1", [
      expect.objectContaining({ id: "workspace-1" }),
    ]);
    expect(setHasHydratedWorkspaces).toHaveBeenCalledWith("server-1", true);
  });

  it("returns the daemon error without mutating workspace state", async () => {
    const mergeWorkspaces = vi.fn();
    const setHasHydratedWorkspaces = vi.fn();
    const createWorkspace = vi.fn().mockResolvedValue({
      workspace: null,
      setupTerminalId: null,
      error: "Directory is not a workspace",
      requestId: "request-1",
    });

    const result = await addExistingWorkspaceDirectly({
      serverId: "server-1",
      workspacePath: "/repo/not-a-workspace",
      isConnected: true,
      client: { createWorkspace },
      mergeWorkspaces,
      setHasHydratedWorkspaces,
    });

    expect(result).toEqual({ ok: false, error: "Directory is not a workspace" });
    expect(mergeWorkspaces).not.toHaveBeenCalled();
    expect(setHasHydratedWorkspaces).not.toHaveBeenCalled();
  });
});
