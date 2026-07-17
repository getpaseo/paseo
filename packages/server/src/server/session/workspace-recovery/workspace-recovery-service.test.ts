import { describe, expect, test } from "vitest";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import { createWorkspaceRecoveryService } from "./workspace-recovery-service.js";

const NOW = "2026-07-11T10:12:30.752Z";

function createProject(): PersistedProjectRecord {
  return createPersistedProjectRecord({
    projectId: "/repo",
    rootPath: "/repo",
    kind: "git",
    displayName: "repo",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function createWorkspace(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "wks_15a1b5630ebaab33",
    projectId: "/repo",
    cwd: "/worktrees/trigger-1525443412986298439",
    kind: "worktree",
    displayName: "diagnose-repro-tdd",
    title: "Codex TDD reproduction",
    branch: "diagnose-repro-tdd",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: NOW,
    ...overrides,
  });
}

function createHarness(input?: {
  workspace?: PersistedWorkspaceRecord | null;
  project?: PersistedProjectRecord | null;
  directories?: string[];
  recreate?: (workspace: PersistedWorkspaceRecord) => Promise<void>;
}) {
  const workspace = input?.workspace === undefined ? createWorkspace() : input.workspace;
  const project = input?.project === undefined ? createProject() : input.project;
  const directories = new Set(input?.directories ?? ["/repo"]);
  const unarchived: string[] = [];
  const recreated: string[] = [];
  const service = createWorkspaceRecoveryService({
    getWorkspace: async (workspaceId) =>
      workspace?.workspaceId === workspaceId ? workspace : null,
    getProject: async (projectId) => (project?.projectId === projectId ? project : null),
    isDirectory: async (path) => directories.has(path),
    recreateWorktree: async (record) => {
      recreated.push(record.workspaceId);
      await input?.recreate?.(record);
    },
    unarchiveWorkspace: async (record) => {
      unarchived.push(record.workspaceId);
    },
  });
  return { service, recreated, unarchived };
}

describe("workspace recovery", () => {
  test("authoritatively describes the archived missing worktree from the failed cloud run", async () => {
    const { service, recreated, unarchived } = createHarness();

    await expect(service.inspect("wks_15a1b5630ebaab33")).resolves.toEqual({
      kind: "recoverable",
      workspaceId: "wks_15a1b5630ebaab33",
      workspaceName: "Codex TDD reproduction",
      action: "restore",
      branch: "diagnose-repro-tdd",
    });
    expect(recreated).toEqual([]);
    expect(unarchived).toEqual([]);
  });

  test("describes an archived workspace whose directory remains as unarchivable", async () => {
    const workspace = createWorkspace({ kind: "directory", branch: null });
    const { service } = createHarness({
      workspace,
      directories: ["/repo", workspace.cwd],
    });

    await expect(service.inspect(workspace.workspaceId)).resolves.toMatchObject({
      kind: "recoverable",
      action: "unarchive",
    });
  });

  test("does not offer recovery for a missing non-worktree directory", async () => {
    const workspace = createWorkspace({ kind: "directory", branch: null });
    const { service } = createHarness({ workspace });

    await expect(service.inspect(workspace.workspaceId)).resolves.toEqual({
      kind: "unavailable",
      workspaceId: workspace.workspaceId,
      reason: "workspace_directory_missing",
      message: "The archived workspace directory no longer exists and cannot be recreated.",
    });
  });

  test("keeps the workspace archived when recreation fails so restore can be retried", async () => {
    let attempts = 0;
    const { service, recreated, unarchived } = createHarness({
      recreate: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("git branch diagnose-repro-tdd is unavailable");
        }
      },
    });

    await expect(service.restore("wks_15a1b5630ebaab33")).rejects.toThrow(
      "git branch diagnose-repro-tdd is unavailable",
    );
    expect(unarchived).toEqual([]);

    await expect(service.restore("wks_15a1b5630ebaab33")).resolves.toEqual({
      workspaceId: "wks_15a1b5630ebaab33",
      action: "restore",
    });
    expect(recreated).toEqual(["wks_15a1b5630ebaab33", "wks_15a1b5630ebaab33"]);
    expect(unarchived).toEqual(["wks_15a1b5630ebaab33"]);
  });
});
