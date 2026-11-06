import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  clearWorkspaceArchivePending,
  isWorkspaceArchivePending,
  markWorkspaceArchivePending,
  markWorkspaceArchiveUndoPending,
  shouldSuppressWorkspaceForLocalArchive,
  settleWorkspaceArchiveIntent,
  shouldSuppressWorkspaceRemovalForLocalUndo,
} from "@/contexts/session-workspace-upserts";

const baseWorkspace: WorkspaceDescriptor = {
  createdAt: null,
  lastUserMessageAt: null,
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
  statusEnteredAt: null,
  diffStat: null,
  scripts: [],
};

function workspace(input?: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return { ...baseWorkspace, ...input };
}

describe("workspace archive pending suppression", () => {
  it("tracks a locally pending workspace archive by id", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
    });

    expect(
      isWorkspaceArchivePending({
        serverId: "server-1",
        workspaceId: "/repo/worktree",
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
    });

    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ archivingAt: null }),
      }),
    ).toBe(true);

    clearWorkspaceArchivePending({ serverId: "server-1", workspaceId: "/repo/worktree" });
  });

  it("does not suppress a same-cwd sibling whose id is not the one archived", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
    });

    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ id: "sibling", workspaceDirectory: "/repo/worktree" }),
      }),
    ).toBe(false);

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

describe("workspace archive undo intent", () => {
  const target = { serverId: "server-1", workspaceId: "/repo/worktree" };

  it("lets host upserts through and holds host removes while an undo is pending", () => {
    markWorkspaceArchivePending(target);
    const undo = markWorkspaceArchiveUndoPending(target);

    expect({
      upsertSuppressed: shouldSuppressWorkspaceForLocalArchive({
        serverId: target.serverId,
        workspace: workspace({ archivingAt: null }),
      }),
      removeSuppressed: shouldSuppressWorkspaceRemovalForLocalUndo(target),
    }).toEqual({ upsertSuppressed: false, removeSuppressed: true });

    settleWorkspaceArchiveIntent(undo);
    expect(shouldSuppressWorkspaceRemovalForLocalUndo(target)).toBe(false);
  });

  it("keeps a newer intent when the request behind an older one settles late", () => {
    const firstArchive = markWorkspaceArchivePending(target);
    const firstUndo = markWorkspaceArchiveUndoPending(target);
    settleWorkspaceArchiveIntent(firstArchive);
    clearWorkspaceArchivePending(target);
    expect(shouldSuppressWorkspaceRemovalForLocalUndo(target)).toBe(true);

    markWorkspaceArchivePending(target);
    settleWorkspaceArchiveIntent(firstUndo);
    expect(isWorkspaceArchivePending(target)).toBe(true);

    const secondUndo = markWorkspaceArchiveUndoPending(target);
    settleWorkspaceArchiveIntent(firstUndo);
    expect(shouldSuppressWorkspaceRemovalForLocalUndo(target)).toBe(true);

    settleWorkspaceArchiveIntent(secondUndo);
  });
});
