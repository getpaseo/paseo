import { describe, expect, test } from "vitest";
import { basename, isAbsolute } from "node:path";

import {
  deriveWorkspaceKind,
  detectStaleWorkspaces,
  generateWorkspaceId,
  generateProjectId,
} from "./workspace-registry-model.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

function createWorkspaceRecord(
  cwd: string,
  workspaceId: string,
  overrides?: { createdAt?: string; archivedAt?: string },
) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd,
    kind: "directory",
    displayName: basename(cwd) || cwd,
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    archivedAt: overrides?.archivedAt ?? null,
  });
}

describe("detectStaleWorkspaces", () => {
  test("returns workspace ids whose directories no longer exist", async () => {
    const checkedDirectories: string[] = [];
    const existingDirectories = new Set(["/tmp/existing"]);

    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/existing", "ws-existing"),
        createWorkspaceRecord("/tmp/missing", "ws-missing"),
      ],
      checkDirectoryExists: async (cwd) => {
        checkedDirectories.push(cwd);
        return existingDirectories.has(cwd);
      },
    });

    expect(Array.from(staleWorkspaceIds)).toEqual(["ws-missing"]);
    expect(checkedDirectories).toEqual(["/tmp/existing", "/tmp/missing"]);
  });

  test("keeps workspaces whose directories exist even when all agents are archived", async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/repo", "ws-repo"),
        createWorkspaceRecord("/tmp/other", "ws-other"),
      ],
      checkDirectoryExists: async () => true,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual([]);
  });

  test("keeps workspaces with no agents when directory exists", async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/active", "ws-active"),
        createWorkspaceRecord("/tmp/no-agents", "ws-no-agents"),
      ],
      checkDirectoryExists: async () => true,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual([]);
  });
});

describe("opaque registry ids", () => {
  test("generates opaque project ids", () => {
    expect(generateProjectId()).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  test("generates opaque workspace ids that are not filesystem paths", () => {
    const workspaceId = generateWorkspaceId();

    expect(workspaceId).toMatch(/^wks_[0-9a-f]+$/);
    expect(isAbsolute(workspaceId)).toBe(false);
  });
});

describe("workspace kind", () => {
  test("classifies plain git worktrees as workspaces of kind worktree", () => {
    expect(
      deriveWorkspaceKind({
        cwd: "/tmp/repo-feature",
        isGit: true,
        currentBranch: "feature/plain",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/tmp/repo-feature",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/tmp/repo",
      }),
    ).toBe("worktree");
  });
});
