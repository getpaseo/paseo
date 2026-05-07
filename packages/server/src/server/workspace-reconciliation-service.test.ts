import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test, vi, afterEach } from "vitest";
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
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";

function createTestRegistries() {
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();

  const projectRegistry: ProjectRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(projects.values()),
    get: async (id: string) => projects.get(id) ?? null,
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
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createWorkspaceGitServiceStub(
  metadataByCwd: Record<
    string,
    {
      projectKind: "git" | "directory";
      projectDisplayName: string;
      workspaceDisplayName: string;
      gitRemote?: string | null;
    }
  >,
) {
  return {
    getWorkspaceGitMetadata: vi.fn(async (cwd: string, options?: { directoryName?: string }) => {
      const metadata = metadataByCwd[cwd];
      const directoryName = options?.directoryName ?? path.basename(cwd);
      if (!metadata) {
        return {
          projectKind: "directory" as const,
          projectDisplayName: directoryName,
          workspaceDisplayName: directoryName,
          gitRemote: null,
          isWorktree: false,
          projectSlug: "untitled",
          repoRoot: null,
          currentBranch: null,
          remoteUrl: null,
        };
      }
      return {
        gitRemote: metadata.gitRemote ?? null,
        isWorktree: false,
        projectSlug: "repo",
        repoRoot: cwd,
        currentBranch: metadata.workspaceDisplayName,
        remoteUrl: metadata.gitRemote ?? null,
        ...metadata,
      };
    }),
  };
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

  test("archives orphaned projects after all workspaces are archived", async () => {
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: "/tmp/does-not-exist-reconcile-orphan",
        kind: "non_git",
        displayName: "orphan",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
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

    const projChange = result.changesApplied.find((c) => c.kind === "project_archived");
    expect(projChange).toBeDefined();
    expect(projects.get("p1")!.archivedAt).toBeTruthy();
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

    // Initialize as git repo
    execFileSync("git", ["init", "-b", "main"], { cwd: resolved, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: resolved,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: resolved, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: resolved,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: resolved, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: resolved, stdio: "ignore" });

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

  test("updates project display name when git remote changes", async () => {
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

    const projUpdate = result.changesApplied.find((c) => c.kind === "project_updated");
    expect(projUpdate).toBeDefined();
    expect(projects.get("p1")!.displayName).toBe("new-owner/new-repo");
  });

  test("updates workspace display name when branch changes", async () => {
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
        displayName: "main",
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
        },
      }),
    });

    const result = await service.runOnce();

    const wsUpdate = result.changesApplied.find((c) => c.kind === "workspace_updated");
    expect(wsUpdate).toBeDefined();
    expect(workspaces.get("w1")!.displayName).toBe("feature-branch");
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

    const onChanges = vi.fn();
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      onChanges,
    });

    await service.runOnce();

    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges.mock.calls[0][0].length).toBeGreaterThan(0);
  });
});
