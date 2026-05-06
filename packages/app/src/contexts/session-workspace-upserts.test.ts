import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  clearWorkspaceArchivePending,
  isWorkspaceArchivePending,
  markWorkspaceArchivePending,
  shouldSuppressWorkspaceForLocalArchive,
} from "@/contexts/session-workspace-upserts";

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

describe("workspace archive pending suppression", () => {
  it("tracks a locally pending workspace archive by id and directory", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
      workspaceDirectory: "/repo/worktree",
    });

    expect(
      isWorkspaceArchivePending({
        serverId: "server-1",
        workspaceId: "/repo/worktree",
      }),
    ).toBe(true);
    expect(
      isWorkspaceArchivePending({
        serverId: "server-1",
        workspaceDirectory: "/repo/worktree",
      }),
    ).toBe(true);
    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ archivingAt: null }),
      }),
    ).toBe(true);

    clearWorkspaceArchivePending({ serverId: "server-1", workspaceId: "/repo/worktree" });

    expect(
      isWorkspaceArchivePending({
        serverId: "server-1",
        workspaceId: "/repo/worktree",
      }),
    ).toBe(false);
  });

  it("suppresses upserts for a locally pending archive", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
      workspaceDirectory: "/repo/worktree",
    });

    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ workspaceDirectory: "/repo/worktree" }),
      }),
    ).toBe(true);

    clearWorkspaceArchivePending({ serverId: "server-1", workspaceId: "/repo/worktree" });
  });

  it("allows upserts when this client did not start the archive", () => {
    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace(),
      }),
    ).toBe(false);
  });

  it("suppresses stale normal upserts while a local archive is pending", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
      workspaceDirectory: "/repo/worktree",
    });

    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ archivingAt: null }),
      }),
    ).toBe(true);

    clearWorkspaceArchivePending({ serverId: "server-1", workspaceId: "/repo/worktree" });
  });
});
