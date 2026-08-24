import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createWorktree } from "../../../utils/worktree.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import { createWorkspaceRecoveryService } from "./workspace-recovery-service.js";

const NOW = "2026-07-11T10:12:30.752Z";
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createProject(overrides: Partial<PersistedProjectRecord> = {}): PersistedProjectRecord {
  return createPersistedProjectRecord({
    projectId: "/project",
    rootPath: "/project",
    kind: "git",
    displayName: "project",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function createWorkspace(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "wks_15a1b5630ebaab33",
    projectId: "/project",
    cwd: "/worktrees/trigger-1525443412986298439",
    kind: "worktree",
    displayName: "diagnose-repro-tdd",
    title: "TDD reproduction",
    branch: "diagnose-repro-tdd",
    worktreeRoot: "/worktrees/trigger-1525443412986298439",
    isPaseoOwnedWorktree: true,
    mainRepoRoot: "/repo",
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
  paseoHome?: string;
  worktreesRoot?: string;
}) {
  const workspace = input?.workspace === undefined ? createWorkspace() : input.workspace;
  const project = input?.project === undefined ? createProject() : input.project;
  const directories = new Set(input?.directories ?? ["/repo"]);
  const unarchived: string[] = [];
  const service = createWorkspaceRecoveryService({
    paseoHome: input?.paseoHome ?? "/paseo-home",
    worktreesRoot: input?.worktreesRoot ?? "/worktrees",
    getWorkspace: async (workspaceId) =>
      workspace?.workspaceId === workspaceId ? workspace : null,
    getProject: async (projectId) => (project?.projectId === projectId ? project : null),
    isDirectory: async (path) => directories.has(path),
    unarchiveWorkspace: async (record) => {
      unarchived.push(record.workspaceId);
    },
  });
  return { service, unarchived };
}

describe("workspace recovery", () => {
  test("describes a missing archived worktree from persisted placement", async () => {
    const { service, unarchived } = createHarness();

    await expect(service.inspect("wks_15a1b5630ebaab33")).resolves.toEqual({
      kind: "recoverable",
      workspaceId: "wks_15a1b5630ebaab33",
      workspaceName: "TDD reproduction",
      action: "restore",
      branch: "diagnose-repro-tdd",
    });
    expect(unarchived).toEqual([]);
  });

  test("unarchives an archived workspace whose exact directory remains", async () => {
    const workspace = createWorkspace({ kind: "directory", branch: null });
    const { service, unarchived } = createHarness({
      workspace,
      directories: [workspace.cwd],
    });

    await expect(service.restore(workspace.workspaceId)).resolves.toEqual({
      workspaceId: workspace.workspaceId,
      action: "unarchive",
    });
    expect(unarchived).toEqual([workspace.workspaceId]);
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

  test("uses the persisted source repository instead of the owning project to restore an exact subdirectory", async () => {
    const { tempDir, repoDir } = createGitRepository();
    const branch = "feature/mixed-project";
    const sourceSubdirectory = join(repoDir, "packages", "app");
    mkdirSync(sourceSubdirectory, { recursive: true });
    writeFileSync(join(sourceSubdirectory, "README.md"), "app\n");
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "add app"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["branch", branch], { cwd: repoDir, stdio: "pipe" });

    const paseoHome = join(tempDir, "paseo-home");
    const worktreesRoot = join(tempDir, "worktrees");
    const created = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "mixed-project",
      source: { kind: "checkout-branch", branchName: branch },
      runSetup: false,
      paseoHome,
      worktreesRoot,
    });
    const worktreeRoot = realpathSync(created.worktreePath);
    const workspaceCwd = join(worktreeRoot, "packages", "app");
    rmSync(worktreeRoot, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });

    const projectRoot = join(tempDir, "explicit-non-git-project");
    mkdirSync(projectRoot);
    const project = createProject({
      projectId: "explicit-non-git-project",
      rootPath: projectRoot,
      kind: "non_git",
    });
    const workspace = createWorkspace({
      workspaceId: "ws-mixed-project-recreate",
      projectId: project.projectId,
      cwd: workspaceCwd,
      branch,
      worktreeRoot,
      mainRepoRoot: repoDir,
    });
    const unarchived: string[] = [];
    const service = createWorkspaceRecoveryService({
      paseoHome,
      worktreesRoot,
      getWorkspace: async (workspaceId) =>
        workspaceId === workspace.workspaceId ? workspace : null,
      getProject: async (projectId) => (projectId === project.projectId ? project : null),
      isDirectory: async (path) => existsSync(path) && statSync(path).isDirectory(),
      unarchiveWorkspace: async (record) => {
        unarchived.push(record.workspaceId);
      },
    });

    await expect(service.restore(workspace.workspaceId)).resolves.toEqual({
      workspaceId: workspace.workspaceId,
      action: "restore",
    });
    expect(existsSync(worktreeRoot)).toBe(true);
    expect(existsSync(workspaceCwd)).toBe(true);
    expect(unarchived).toEqual([workspace.workspaceId]);
  });

  test("keeps an exact-subdirectory workspace archived when its branch lacks that directory", async () => {
    const { tempDir, repoDir } = createGitRepository();
    const branch = "feature/without-subproject";
    execFileSync("git", ["branch", branch], { cwd: repoDir, stdio: "pipe" });
    const paseoHome = join(tempDir, "paseo-home");
    const worktreesRoot = join(tempDir, "worktrees");
    const created = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "without-subproject",
      source: { kind: "checkout-branch", branchName: branch },
      runSetup: false,
      paseoHome,
      worktreesRoot,
    });
    const worktreeRoot = realpathSync(created.worktreePath);
    const workspaceCwd = join(worktreeRoot, "packages", "app");
    rmSync(worktreeRoot, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });

    const project = createProject({ rootPath: repoDir });
    const workspace = createWorkspace({
      workspaceId: "ws-missing-restored-subdirectory",
      cwd: workspaceCwd,
      branch,
      worktreeRoot,
      mainRepoRoot: repoDir,
    });
    const unarchived: string[] = [];
    const service = createWorkspaceRecoveryService({
      paseoHome,
      worktreesRoot,
      getWorkspace: async (workspaceId) =>
        workspaceId === workspace.workspaceId ? workspace : null,
      getProject: async (projectId) => (projectId === project.projectId ? project : null),
      isDirectory: async (targetPath) =>
        existsSync(targetPath) && statSync(targetPath).isDirectory(),
      unarchiveWorkspace: async (record) => {
        unarchived.push(record.workspaceId);
      },
    });

    await expect(service.restore(workspace.workspaceId)).rejects.toThrow(
      "Selected project directory is missing from the restored worktree",
    );
    expect(unarchived).toEqual([]);
    expect(existsSync(worktreeRoot)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir,
        stdio: "pipe",
      })
        .toString()
        .includes("without-subproject"),
    ).toBe(false);
  });

  test("keeps the workspace archived when its persisted source repository is missing", async () => {
    const workspace = createWorkspace({ mainRepoRoot: "/missing-source" });
    const { service, unarchived } = createHarness({
      workspace,
      directories: ["/project"],
    });

    await expect(service.inspect(workspace.workspaceId)).resolves.toEqual({
      kind: "unavailable",
      workspaceId: workspace.workspaceId,
      reason: "project_directory_missing",
      message: "The source repository needed to restore this worktree no longer exists.",
    });
    await expect(service.restore(workspace.workspaceId)).rejects.toThrow(
      "The source repository needed to restore this worktree no longer exists.",
    );
    expect(unarchived).toEqual([]);
  });
});

function createGitRepository(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "paseo-workspace-recovery-"));
  tempDirectories.push(tempDir);
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  writeFileSync(join(repoDir, "README.md"), "initial\n");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}
