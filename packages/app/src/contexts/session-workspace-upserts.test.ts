import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { shouldSuppressWorkspaceUpsertForLocalArchive } from "@/contexts/session-workspace-upserts";

const baseWorkspace: WorkspaceDescriptor = {
  id: "/repo/worktree",
  projectId: "/repo",
  projectDisplayName: "Repo",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "feature",
  status: "done",
  archivingAt: "2026-04-30T00:00:00.000Z",
  diffStat: null,
  scripts: [],
};

function workspace(input?: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return { ...baseWorkspace, ...input };
}

describe("shouldSuppressWorkspaceUpsertForLocalArchive", () => {
  it("suppresses archiving upserts for a locally pending archive", () => {
    const isArchivePending = vi.fn(() => true);

    expect(
      shouldSuppressWorkspaceUpsertForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ workspaceDirectory: "/repo/worktree" }),
        isArchivePending,
      }),
    ).toBe(true);
    expect(isArchivePending).toHaveBeenCalledWith({
      serverId: "server-1",
      cwd: "/repo/worktree",
    });
  });

  it("allows archiving upserts when this client did not start the archive", () => {
    expect(
      shouldSuppressWorkspaceUpsertForLocalArchive({
        serverId: "server-1",
        workspace: workspace(),
        isArchivePending: () => false,
      }),
    ).toBe(false);
  });

  it("allows normal upserts while a local archive is pending", () => {
    expect(
      shouldSuppressWorkspaceUpsertForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ archivingAt: null }),
        isArchivePending: () => true,
      }),
    ).toBe(false);
  });
});
