import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import {
  type ReconciliationChange,
  WorkspaceReconciliationService,
} from "./workspace-reconciliation-service.js";

function createTestRegistries() {
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();

  const projectRegistry: ProjectRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(projects.values()),
    get: async (id: string) => projects.get(id) ?? null,
    getOrCreateActiveByRoot: async (input) => {
      const existing = Array.from(projects.values()).find(
        (project) => !project.archivedAt && project.rootPath === input.rootPath,
      );
      if (existing) return existing;
      const record = createPersistedProjectRecord({
        projectId: `prj_${projects.size}`,
        rootPath: input.rootPath,
        kind: input.kind,
        displayName: input.displayName,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      });
      projects.set(record.projectId, record);
      return record;
    },
    upsert: async (record: PersistedProjectRecord) => {
      projects.set(record.projectId, record);
    },
    archive: async (id: string, archivedAt: string) => {
      const existing = projects.get(id);
      if (existing) {
        projects.set(id, { ...existing, archivedAt, updatedAt: archivedAt });
      }
    },
    remove: async (id: string) => {
      projects.delete(id);
    },
  };

  const workspaceRegistry: WorkspaceRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(workspaces.values()),
    get: async (id: string) => workspaces.get(id) ?? null,
    upsert: async (record: PersistedWorkspaceRecord) => {
      workspaces.set(record.workspaceId, record);
    },
    archive: async (id: string, archivedAt: string) => {
      const existing = workspaces.get(id);
      if (existing) {
        workspaces.set(id, { ...existing, archivedAt, updatedAt: archivedAt });
      }
    },
    remove: async (id: string) => {
      workspaces.delete(id);
    },
  };

  return { projects, workspaces, projectRegistry, workspaceRegistry };
}

function createTestLogger() {
  const logger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

interface CapturedLogRecord {
  message: string;
  payload: unknown;
}

function createCapturingLogger() {
  const infoRecords: CapturedLogRecord[] = [];
  const logger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: (payload: unknown, message?: string) => {
      infoRecords.push({ payload, message: message ?? "" });
    },
    warn: () => undefined,
    error: () => undefined,
  };
  return { logger: logger as unknown as pino.Logger, infoRecords };
}

function createWorkspaceGitServiceStub(
  metadataByCwd: Record<
    string,
    {
      projectKind: "git" | "directory";
      projectDisplayName: string;
      workspaceDisplayName: string;
      gitRemote?: string | null;
      currentBranch?: string | null;
    }
  >,
) {
  return {
    getCheckout: async (cwd: string) => {
      const metadata = metadataByCwd[cwd];
      if (!metadata) {
        return {
          cwd,
          isGit: false as const,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        };
      }
      return {
        cwd,
        isGit: metadata.projectKind === "git",
        currentBranch: metadata.currentBranch ?? metadata.workspaceDisplayName,
        remoteUrl: metadata.gitRemote ?? null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      };
    },
  };
}

function createCheckout(
  cwd: string,
  overrides: Partial<ProjectCheckoutLitePayload> = {},
): ProjectCheckoutLitePayload {
  return {
    cwd,
    isGit: false,
    currentBranch: null,
    remoteUrl: null,
    worktreeRoot: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    ...overrides,
  };
}

class TestCheckouts {
  readonly reads: string[] = [];
  private readonly checkouts = new Map<string, ProjectCheckoutLitePayload>();

  set(cwd: string, checkout: ProjectCheckoutLitePayload): void {
    this.checkouts.set(cwd, checkout);
  }

  async getCheckout(cwd: string): Promise<ProjectCheckoutLitePayload> {
    this.reads.push(cwd);
    return this.checkouts.get(cwd) ?? createCheckout(cwd);
  }
}

function initGitRepoInDir(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

function createTempGitRepo(prefix: string): string {
  const raw = mkdtempSync(path.join(tmpdir(), prefix));
  const dir = realpathSync(raw);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

const timestamp = "2025-01-01T00:00:00.000Z";

describe("WorkspaceReconciliationService", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("metadata reconciliation leaves missing workspaces active while a full pass archives them", async () => {
    const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-metadata-only-")));
    const missingWorkspace = path.join(projectRoot, "missing-workspace");
    tempDirs.push(projectRoot);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: projectRoot,
        kind: "non_git",
        displayName: "metadata-only",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: missingWorkspace,
        kind: "directory",
        displayName: "missing-workspace",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
    });

    const metadataResult = await service.reconcileGitMetadata();

    expect(metadataResult.changesApplied).toEqual([]);
    expect(workspaces.get("w1")?.archivedAt).toBeNull();

    const fullResult = await service.runOnce();

    expect(fullResult.changesApplied).toEqual([
      {
        kind: "workspace_archived",
        workspaceId: "w1",
        directory: missingWorkspace,
        reason: "directory_missing",
      },
    ]);
    expect(workspaces.get("w1")?.archivedAt).toEqual(expect.any(String));
  });

  test("reads fresh checkout facts on every metadata pass", async () => {
    const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-fresh-git-")));
    tempDirs.push(projectRoot);
    const { projects, projectRegistry, workspaceRegistry } = createTestRegistries();
    const git = new TestCheckouts();
    git.set(projectRoot, createCheckout(projectRoot));
    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: projectRoot,
        kind: "non_git",
        displayName: "fresh-git",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: git,
    });

    const beforeGitInit = await service.reconcileGitMetadata();
    git.set(
      projectRoot,
      createCheckout(projectRoot, {
        isGit: true,
        currentBranch: "main",
        worktreeRoot: projectRoot,
      }),
    );
    const afterGitInit = await service.reconcileGitMetadata();

    expect(beforeGitInit.changesApplied).toEqual([]);
    expect(afterGitInit.changesApplied).toEqual([
      {
        kind: "project_updated",
        projectId: "p1",
        directory: projectRoot,
        fields: { kind: "git" },
      },
    ]);
    expect(git.reads).toEqual([projectRoot, projectRoot]);
    expect(projects.get("p1")?.kind).toBe("git");
  });

  test("deduplicates equivalent project and workspace paths across legacy duplicate projects", async () => {
    const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-global-root-")));
    const workspaceRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "reconcile-global-workspace-")),
    );
    tempDirs.push(projectRoot, workspaceRoot);
    const equivalentProjectRoot = `${projectRoot}${path.sep}.`;
    const equivalentWorkspaceRoot = `${workspaceRoot}${path.sep}.`;
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    const git = new TestCheckouts();
    const projectCheckout = createCheckout(projectRoot, {
      isGit: true,
      currentBranch: "main",
      worktreeRoot: projectRoot,
    });
    const workspaceCheckout = createCheckout(workspaceRoot, {
      isGit: true,
      currentBranch: "topic",
      worktreeRoot: workspaceRoot,
    });
    git.set(projectRoot, projectCheckout);
    git.set(equivalentProjectRoot, projectCheckout);
    git.set(workspaceRoot, workspaceCheckout);
    git.set(equivalentWorkspaceRoot, workspaceCheckout);

    for (const [projectId, rootPath] of [
      ["p1", projectRoot],
      ["p2", equivalentProjectRoot],
    ] as const) {
      projects.set(
        projectId,
        createPersistedProjectRecord({
          projectId,
          rootPath,
          kind: "git",
          displayName: projectId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    for (const [workspaceId, projectId, cwd] of [
      ["w1", "p1", workspaceRoot],
      ["w2", "p2", equivalentWorkspaceRoot],
    ] as const) {
      workspaces.set(
        workspaceId,
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId,
          cwd,
          kind: "local_checkout",
          displayName: workspaceId,
          branch: "topic",
          worktreeRoot: workspaceRoot,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: git,
    });

    const result = await service.reconcileGitMetadata();

    expect(result.changesApplied).toEqual([]);
    expect(git.reads).toEqual([projectRoot, workspaceRoot]);
  });

  test("updates mutable Git facts without changing project or workspace identity", async () => {
    const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-stable-project-")));
    const workspaceRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "reconcile-explicit-workspace-")),
    );
    tempDirs.push(projectRoot, workspaceRoot);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    const originalProject = createPersistedProjectRecord({
      projectId: "p1",
      rootPath: projectRoot,
      kind: "non_git",
      displayName: "Stable project name",
      customName: "Pinned project name",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const originalWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "w1",
      projectId: "p1",
      cwd: workspaceRoot,
      kind: "local_checkout",
      displayName: "Stable workspace name",
      title: "Pinned workspace name",
      branch: "stale-branch",
      baseBranch: "main",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    projects.set(originalProject.projectId, originalProject);
    workspaces.set(originalWorkspace.workspaceId, originalWorkspace);
    const git = new TestCheckouts();
    git.set(
      projectRoot,
      createCheckout(projectRoot, {
        isGit: true,
        currentBranch: "main",
        worktreeRoot: projectRoot,
      }),
    );
    git.set(workspaceRoot, createCheckout(workspaceRoot));
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: git,
    });

    const result = await service.reconcileGitMetadata();

    expect(result.changesApplied).toEqual(
      expect.arrayContaining([
        {
          kind: "project_updated",
          projectId: "p1",
          directory: projectRoot,
          fields: { kind: "git" },
        },
        {
          kind: "workspace_updated",
          workspaceId: "w1",
          directory: workspaceRoot,
          fields: {
            branch: null,
            kind: "directory",
          },
        },
      ]),
    );
    expect(result.changesApplied).toHaveLength(2);
    expect(projects.get("p1")).toEqual({
      ...originalProject,
      kind: "git",
      updatedAt: expect.any(String),
    });
    expect(workspaces.get("w1")).toEqual({
      ...originalWorkspace,
      kind: "directory",
      branch: null,
      updatedAt: expect.any(String),
    });
  });

  test("archives workspaces whose directories no longer exist", async () => {
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: "/tmp/does-not-exist-reconcile-test",
        kind: "non_git",
        displayName: "ghost",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: "/tmp/does-not-exist-reconcile-test",
        kind: "directory",
        displayName: "ghost",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
    });

    const result = await service.runOnce();

    expect(result.changesApplied.length).toBeGreaterThanOrEqual(1);
    const wsChange = result.changesApplied.find((c) => c.kind === "workspace_archived");
    expect(wsChange).toBeDefined();
    expect(workspaces.get("w1")!.archivedAt).toBeTruthy();
  });

  test("keeps a project active after all its workspaces are archived", async () => {
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    const project = createPersistedProjectRecord({
      projectId: "p1",
      rootPath: "/tmp/does-not-exist-reconcile-orphan",
      kind: "non_git",
      displayName: "orphan",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    projects.set(project.projectId, project);
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: "/tmp/does-not-exist-reconcile-orphan",
        kind: "directory",
        displayName: "orphan",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
    });

    const result = await service.runOnce();

    expect(result.changesApplied).toEqual([
      {
        kind: "workspace_archived",
        workspaceId: "w1",
        directory: "/tmp/does-not-exist-reconcile-orphan",
        reason: "directory_missing",
      },
    ]);
    expect(workspaces.get("w1")).toEqual({
      workspaceId: "w1",
      projectId: "p1",
      cwd: "/tmp/does-not-exist-reconcile-orphan",
      kind: "directory",
      displayName: "orphan",
      title: null,
      pinnedAt: null,
      branch: null,
      worktreeRoot: null,
      baseBranch: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
      createdAt: timestamp,
      updatedAt: expect.any(String),
      archivedAt: expect.any(String),
    });
    expect(projects.get("p1")).toEqual(project);
  });

  test("updates project kind when a directory becomes a git repo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reconcile-git-init-"));
    const resolved = realpathSync(dir);
    tempDirs.push(resolved);
    writeFileSync(path.join(resolved, "README.md"), "# Test\n");

    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: resolved,
        kind: "non_git",
        displayName: path.basename(resolved),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: resolved,
        kind: "local_checkout",
        displayName: path.basename(resolved),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    initGitRepoInDir(resolved);

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: createWorkspaceGitServiceStub({
        [resolved]: {
          projectKind: "git",
          projectDisplayName: path.basename(resolved),
          workspaceDisplayName: "main",
        },
      }),
    });

    const result = await service.runOnce();

    const projUpdate = result.changesApplied.find((c) => c.kind === "project_updated");
    expect(projUpdate).toBeDefined();
    expect(projects.get("p1")!.kind).toBe("git");
  });

  test("updates workspace kind when a directory becomes a git repo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reconcile-ws-kind-"));
    const resolved = realpathSync(dir);
    tempDirs.push(resolved);
    writeFileSync(path.join(resolved, "README.md"), "# Test\n");

    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: resolved,
        kind: "non_git",
        displayName: path.basename(resolved),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: resolved,
        kind: "directory",
        displayName: path.basename(resolved),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    initGitRepoInDir(resolved);

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: createWorkspaceGitServiceStub({
        [resolved]: {
          projectKind: "git",
          projectDisplayName: path.basename(resolved),
          workspaceDisplayName: "main",
        },
      }),
    });

    await service.runOnce();

    expect(projects.get("p1")!.kind).toBe("git");
    expect(workspaces.get("w1")!.kind).toBe("local_checkout");
  });

  test("keeps legacy duplicate projects and workspace membership intact", async () => {
    const repoDir = createTempGitRepo("reconcile-duplicate-project-");
    tempDirs.push(repoDir);
    const canonicalWorktreeDir = path.join(repoDir, ".paseo", "worktrees", "focused-bat");
    const duplicateWorktreeDir = path.join(repoDir, ".paseo", "worktrees", "gigantic-blowfish");
    mkdirSync(canonicalWorktreeDir, { recursive: true });
    mkdirSync(duplicateWorktreeDir, { recursive: true });
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "remote:github.com/blank-dot-page/editor",
      createPersistedProjectRecord({
        projectId: "remote:github.com/blank-dot-page/editor",
        rootPath: repoDir,
        kind: "git",
        displayName: "blank-dot-page/editor",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    projects.set(
      repoDir,
      createPersistedProjectRecord({
        projectId: repoDir,
        rootPath: repoDir,
        kind: "git",
        displayName: "editor",
        customName: "Editor",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "focused-bat",
      createPersistedWorkspaceRecord({
        workspaceId: "focused-bat",
        projectId: "remote:github.com/blank-dot-page/editor",
        cwd: canonicalWorktreeDir,
        kind: "worktree",
        displayName: "update-og-image",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "gigantic-blowfish",
      createPersistedWorkspaceRecord({
        workspaceId: "gigantic-blowfish",
        projectId: repoDir,
        cwd: duplicateWorktreeDir,
        kind: "worktree",
        displayName: "markdown-view",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: createWorkspaceGitServiceStub({
        [repoDir]: {
          projectKind: "git",
          projectDisplayName: "blank-dot-page/editor",
          workspaceDisplayName: "main",
          gitRemote: "git@github.com:blank-dot-page/editor.git",
        },
        [canonicalWorktreeDir]: {
          projectKind: "git",
          projectDisplayName: "blank-dot-page/editor",
          workspaceDisplayName: "update-og-image",
          gitRemote: "git@github.com:blank-dot-page/editor.git",
        },
        [duplicateWorktreeDir]: {
          projectKind: "git",
          projectDisplayName: "blank-dot-page/editor",
          workspaceDisplayName: "markdown-view",
          gitRemote: "git@github.com:blank-dot-page/editor.git",
        },
      }),
    });

    const result = await service.runOnce();

    expect(result.changesApplied.map((change) => change.kind).sort()).toEqual([
      "workspace_updated",
      "workspace_updated",
    ]);
    expect(projects.get("remote:github.com/blank-dot-page/editor")).toMatchObject({
      projectId: "remote:github.com/blank-dot-page/editor",
      rootPath: repoDir,
      displayName: "blank-dot-page/editor",
      customName: null,
      archivedAt: null,
    });
    expect(projects.get(repoDir)).toMatchObject({
      projectId: repoDir,
      rootPath: repoDir,
      displayName: "editor",
      customName: "Editor",
      archivedAt: null,
    });
    expect(workspaces.get("focused-bat")).toMatchObject({
      projectId: "remote:github.com/blank-dot-page/editor",
      archivedAt: null,
    });
    expect(workspaces.get("gigantic-blowfish")).toMatchObject({
      projectId: repoDir,
      archivedAt: null,
    });
  });

  test("keeps project display name stable when git remote changes", async () => {
    const dir = createTempGitRepo("reconcile-remote-");
    tempDirs.push(dir);

    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: dir,
        kind: "git",
        displayName: "old-owner/old-repo",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: dir,
        kind: "local_checkout",
        displayName: "main",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    // Change the remote
    execFileSync("git", ["remote", "add", "origin", "git@github.com:new-owner/new-repo.git"], {
      cwd: dir,
      stdio: "ignore",
    });

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: createWorkspaceGitServiceStub({
        [dir]: {
          projectKind: "git",
          projectDisplayName: "new-owner/new-repo",
          workspaceDisplayName: "main",
          gitRemote: "git@github.com:new-owner/new-repo.git",
        },
      }),
    });

    const result = await service.runOnce();

    expect(result.changesApplied.find((c) => c.kind === "project_updated")).toBeUndefined();
    expect(projects.get("p1")!.displayName).toBe("old-owner/old-repo");
  });

  test("keeps custom and default names stable when the remote changes", async () => {
    const dir = createTempGitRepo("reconcile-customname-");
    tempDirs.push(dir);

    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: dir,
        kind: "git",
        displayName: "old-owner/old-repo",
        customName: "My Fork",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: dir,
        kind: "local_checkout",
        displayName: "main",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    execFileSync("git", ["remote", "add", "origin", "git@github.com:new-owner/new-repo.git"], {
      cwd: dir,
      stdio: "ignore",
    });

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: createWorkspaceGitServiceStub({
        [dir]: {
          projectKind: "git",
          projectDisplayName: "new-owner/new-repo",
          workspaceDisplayName: "main",
          gitRemote: "git@github.com:new-owner/new-repo.git",
        },
      }),
    });

    await service.runOnce();

    expect(projects.get("p1")!.displayName).toBe("old-owner/old-repo");
    expect(projects.get("p1")!.customName).toBe("My Fork");
  });

  test("keeps persisted Git metadata when a workspace checkout read fails", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "reconcile-checkout-read-project-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    mkdirSync(workspaceRoot);
    tempDirs.push(projectRoot);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    const project = createPersistedProjectRecord({
      projectId: "p1",
      rootPath: projectRoot,
      kind: "non_git",
      displayName: "project",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "w1",
      projectId: project.projectId,
      cwd: workspaceRoot,
      kind: "local_checkout",
      displayName: "workspace",
      branch: "feature",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    projects.set(project.projectId, project);
    workspaces.set(workspace.workspaceId, workspace);
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: {
        getCheckout: async (cwd) => {
          if (cwd === workspaceRoot) throw new Error("Git read failed");
          return createCheckout(cwd, { isGit: true, currentBranch: "main", worktreeRoot: cwd });
        },
      },
    });

    const result = await service.reconcileGitMetadata();

    expect(result.changesApplied).toEqual([]);
    expect(projects.get(project.projectId)).toEqual(project);
    expect(workspaces.get(workspace.workspaceId)).toEqual(workspace);
  });

  test("archives non-directory workspaces without blocking sibling reconciliation", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "reconcile-file-workspace-"));
    const replacedWorkspace = path.join(projectRoot, "replaced-workspace");
    const siblingWorkspace = path.join(projectRoot, "sibling-workspace");
    writeFileSync(replacedWorkspace, "not a directory\n");
    mkdirSync(siblingWorkspace);
    tempDirs.push(projectRoot);

    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: projectRoot,
        kind: "non_git",
        displayName: "project",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "replaced",
      createPersistedWorkspaceRecord({
        workspaceId: "replaced",
        projectId: "p1",
        cwd: replacedWorkspace,
        kind: "directory",
        displayName: "replaced-workspace",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "sibling",
      createPersistedWorkspaceRecord({
        workspaceId: "sibling",
        projectId: "p1",
        cwd: siblingWorkspace,
        kind: "directory",
        displayName: "sibling-workspace",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: {
        getCheckout: async (cwd) => {
          if (cwd === replacedWorkspace) {
            throw new Error("Git cannot use a regular file as cwd");
          }
          return createCheckout(cwd, {
            isGit: true,
            currentBranch: cwd === siblingWorkspace ? "feature/sibling" : "main",
            worktreeRoot: cwd,
          });
        },
      },
    });

    const result = await service.runOnce();

    expect(result.changesApplied).toEqual([
      {
        kind: "workspace_archived",
        workspaceId: "replaced",
        directory: replacedWorkspace,
        reason: "directory_missing",
      },
      {
        kind: "project_updated",
        projectId: "p1",
        directory: projectRoot,
        fields: { kind: "git" },
      },
      {
        kind: "workspace_updated",
        workspaceId: "sibling",
        directory: siblingWorkspace,
        fields: {
          kind: "local_checkout",
          branch: "feature/sibling",
          worktreeRoot: siblingWorkspace,
        },
      },
    ]);
    expect(workspaces.get("replaced")?.archivedAt).toEqual(expect.any(String));
    expect(workspaces.get("sibling")).toMatchObject({
      kind: "local_checkout",
      branch: "feature/sibling",
    });
  });

  test("updates workspace branch metadata without clobbering the workspace name", async () => {
    const dir = createTempGitRepo("reconcile-branch-");
    tempDirs.push(dir);

    execFileSync("git", ["checkout", "-b", "feature-branch"], { cwd: dir, stdio: "ignore" });

    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: dir,
        kind: "git",
        displayName: path.basename(dir),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: dir,
        kind: "local_checkout",
        displayName: "Human workspace title",
        branch: "main",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: createWorkspaceGitServiceStub({
        [dir]: {
          projectKind: "git",
          projectDisplayName: path.basename(dir),
          workspaceDisplayName: "feature-branch",
          currentBranch: "feature-branch",
        },
      }),
    });

    const result = await service.runOnce();

    const wsUpdate = result.changesApplied.find((c) => c.kind === "workspace_updated");
    expect(wsUpdate).toBeDefined();
    expect(wsUpdate).toMatchObject({
      kind: "workspace_updated",
      fields: { branch: "feature-branch" },
    });
    expect(workspaces.get("w1")!.displayName).toBe("Human workspace title");
    expect(workspaces.get("w1")!.branch).toBe("feature-branch");
  });

  test("does not modify already-archived records", async () => {
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: "/tmp/does-not-exist-archived",
        kind: "non_git",
        displayName: "archived",
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: "/tmp/does-not-exist-archived",
        kind: "directory",
        displayName: "archived",
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: timestamp,
      }),
    );

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
    });

    const result = await service.runOnce();

    expect(result.changesApplied).toHaveLength(0);
  });

  test("calls onChanges callback when changes are applied", async () => {
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: "/tmp/does-not-exist-callback-test",
        kind: "non_git",
        displayName: "ghost",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: "/tmp/does-not-exist-callback-test",
        kind: "directory",
        displayName: "ghost",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    const reportedChanges: ReconciliationChange[] = [];
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      onChanges: (changes) => reportedChanges.push(...changes),
    });

    await service.runOnce();

    expect(reportedChanges).toEqual([
      {
        kind: "workspace_archived",
        workspaceId: "w1",
        directory: "/tmp/does-not-exist-callback-test",
        reason: "directory_missing",
      },
    ]);
  });

  test("logs reconciliation changes with affected paths and reasons", async () => {
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    const { logger, infoRecords } = createCapturingLogger();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: "/tmp/does-not-exist-log-test",
        kind: "non_git",
        displayName: "ghost",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: "/tmp/does-not-exist-log-test",
        kind: "directory",
        displayName: "ghost",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger,
    });

    await service.runOnce();

    expect(infoRecords).toEqual([
      {
        message: "Workspace reconciliation applied changes",
        payload: expect.objectContaining({
          changeCount: 1,
          changes: expect.arrayContaining([
            {
              kind: "workspace_archived",
              workspaceId: "w1",
              directory: "/tmp/does-not-exist-log-test",
              reason: "directory_missing",
            },
          ]),
          durationMs: expect.any(Number),
        }),
      },
    ]);
    expect(projects.get("p1")!.archivedAt).toBeFalsy();
  });

  test("does not log reconciliation when no changes are applied", async () => {
    const { projectRegistry, workspaceRegistry } = createTestRegistries();
    const { logger, infoRecords } = createCapturingLogger();

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger,
    });

    await service.runOnce();

    expect(infoRecords).toEqual([]);
  });

  test("backfills persisted worktree ownership from the current checkout", async () => {
    const rootPath = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-worktree-owner-")));
    tempDirs.push(rootPath);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    const checkouts = new TestCheckouts();
    checkouts.set(
      rootPath,
      createCheckout(rootPath, {
        isGit: true,
        worktreeRoot: rootPath,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: "/tmp/main-repo",
      }),
    );
    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath,
        kind: "git",
        displayName: "worktree",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: rootPath,
        kind: "worktree",
        displayName: "worktree",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      workspaceGitService: checkouts,
      logger: createTestLogger(),
    });

    const result = await service.reconcileGitMetadata();

    expect(result.changesApplied).toEqual([
      {
        kind: "workspace_updated",
        workspaceId: "w1",
        directory: rootPath,
        fields: {
          worktreeRoot: rootPath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: "/tmp/main-repo",
        },
      },
    ]);
    expect(workspaces.get("w1")).toMatchObject({
      worktreeRoot: rootPath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: "/tmp/main-repo",
    });
  });
});
