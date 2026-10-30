import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  createTestRegistries,
  createTestLogger,
  deferred,
} from "./test-fixtures/reconciliation-registries.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type pino from "pino";
import { afterAll, beforeAll, afterEach, describe, expect, test } from "vitest";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  type ReconciliationChange,
  WorkspaceReconciliationService,
} from "./workspace-reconciliation-service.js";
import { deriveProjectKey } from "./project-key.js";

let probeDirectory: string;
let probePath: string;
beforeAll(async () => {
  probeDirectory = mkdtempSync(path.join(tmpdir(), "reconciliation-probe-"));
  probePath = path.join(probeDirectory, "reconciliation.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("./test-fixtures/reconciliation-responsiveness.ts", import.meta.url)),
    ],
    outfile: probePath,
    bundle: true,
    platform: "node",
    format: "esm",
  });
});
afterAll(() => rmSync(probeDirectory, { recursive: true, force: true }));

function canonicalLocalProjectKey(rootPath: string): string {
  return deriveProjectKey({
    rootPath,
    remoteUrl: null,
    worktreeRoot: null,
    mainRepoRoot: null,
  });
}

interface CapturedLogRecord {
  message: string;
  payload: unknown;
}

function createCapturingLogger() {
  const infoRecords: CapturedLogRecord[] = [];
  const warnRecords: CapturedLogRecord[] = [];
  const logger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: (payload: unknown, message?: string) => {
      infoRecords.push({ payload, message: message ?? "" });
    },
    warn: (payload: unknown, message?: string) => {
      warnRecords.push({ payload, message: message ?? "" });
    },
    error: () => undefined,
  };
  return { logger: logger as unknown as pino.Logger, infoRecords, warnRecords };
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

  test("does not emit a duplicate archive when user archival commits before reconciliation's archive", async () => {
    const rootPath = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-archive-commit-")));
    tempDirs.push(rootPath);
    const { projects, workspaces, projectRegistry, workspaceRegistry, holdNextArchive } =
      createTestRegistries();
    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath,
        projectKey: canonicalLocalProjectKey(rootPath),
        kind: "non_git",
        displayName: "project",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: path.join(rootPath, "missing"),
        kind: "directory",
        displayName: "workspace",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const callbacks: string[] = [];
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      onWorkspaceArchived: (id) => {
        callbacks.push(id);
      },
    });
    const gate = holdNextArchive();
    try {
      const scan = service.runOnce();
      await gate.started.promise;
      expect(await workspaceRegistry.archive("w1", timestamp)).toBe(true);
      gate.release.resolve();
      expect((await scan).changesApplied).toEqual([]);
      expect(callbacks).toEqual([]);
      expect(workspaces.get("w1")?.archivedAt).toBe(timestamp);
    } finally {
      gate.release.resolve();
      service.dispose();
    }
  });

  test("preserves paths while two inspections saturate capacity, logs once, and recovers after they drain", async () => {
    const rootPath = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-saturated-")));
    tempDirs.push(rootPath);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    const { logger, warnRecords, infoRecords } = createCapturingLogger();
    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath,
        projectKey: canonicalLocalProjectKey(rootPath),
        kind: "non_git",
        displayName: "project",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const ids = ["hung1", "hung2", "healthy"];
    for (const workspaceId of ids) {
      workspaces.set(
        workspaceId,
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: "p1",
          cwd: path.join(rootPath, workspaceId),
          kind: "directory",
          displayName: workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    const release = deferred();
    const calls: string[] = [];
    let recovered = false;
    let ticks = 0;
    const probe = setInterval(() => ticks++, 1);
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger,
      inspectionTimeoutMs: 30,
      inspectDirectory: async (targetPath) => {
        calls.push(targetPath);
        if (!recovered && path.basename(targetPath).startsWith("hung")) await release.promise;
        return "directory";
      },
    });
    try {
      const result = await service.runOnce();
      expect(ticks).toBeGreaterThan(0);
      expect(result.durationMs).toBeLessThan(1000);
      expect(result.changesApplied).toEqual([]);
      expect(calls).toEqual(ids.slice(0, 2).map((id) => path.join(rootPath, id)));
      expect([...workspaces.values()].map((workspace) => workspace.archivedAt)).toEqual([
        null,
        null,
        null,
      ]);
      expect(warnRecords.filter((record) => record.message.includes("saturated"))).toEqual([
        {
          message: "Workspace directory inspection saturated; preserving uninspected workspaces",
          payload: { paths: ids.slice(0, 2).map((id) => path.join(rootPath, id)) },
        },
      ]);
      recovered = true;
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(infoRecords).toEqual([
        {
          message:
            "Timed-out workspace directory inspections drained; reconciliation capacity restored",
          payload: {},
        },
      ]);
      calls.length = 0;
      await service.runOnce();
      expect(calls).toEqual([...ids.map((id) => path.join(rootPath, id)), rootPath]);
      expect(warnRecords.filter((record) => record.message.includes("saturated"))).toHaveLength(1);
    } finally {
      release.resolve();
      clearInterval(probe);
      service.dispose();
    }
  });

  test("inspects every healthy path when one hung inspection times out during a longer scan", async () => {
    const rootPath = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-long-hung-")));
    tempDirs.push(rootPath);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath,
        projectKey: canonicalLocalProjectKey(rootPath),
        kind: "non_git",
        displayName: "project",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const healthyIds = Array.from({ length: 12 }, (_, i) => `healthy${i}`);
    for (const workspaceId of ["hung", ...healthyIds]) {
      workspaces.set(
        workspaceId,
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: "p1",
          cwd: path.join(rootPath, workspaceId),
          kind: "directory",
          displayName: workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    const calls: string[] = [];
    let outstanding = 0;
    let maximumOutstanding = 0;
    const { logger, warnRecords } = createCapturingLogger();
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger,
      inspectionTimeoutMs: 100,
      inspectDirectory: async (targetPath) => {
        calls.push(targetPath);
        maximumOutstanding = Math.max(maximumOutstanding, ++outstanding);
        if (path.basename(targetPath) === "hung") return new Promise(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        outstanding--;
        return "directory";
      },
    });
    try {
      const result = await service.runOnce();
      expect(result.durationMs).toBeGreaterThan(100);
      expect(calls).toEqual(
        ["hung", ...healthyIds].map((id) => path.join(rootPath, id)).concat(rootPath),
      );
      expect(maximumOutstanding).toBe(2);
      expect(outstanding).toBe(1);
      expect(workspaces.get("hung")?.archivedAt).toBeNull();
      expect(result.changesApplied).toEqual([]);
      expect(warnRecords.filter((record) => record.message.includes("saturated"))).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  test("times out a hung inspection without archiving it or blocking healthy paths, and retains its IO slot", async () => {
    const rootPath = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-hung-")));
    tempDirs.push(rootPath);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath,
        projectKey: canonicalLocalProjectKey(rootPath),
        kind: "non_git",
        displayName: "project",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    for (const workspaceId of ["hung", "healthy", "healthy2", "healthy3"]) {
      workspaces.set(
        workspaceId,
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: "p1",
          cwd: path.join(rootPath, workspaceId),
          kind: "directory",
          displayName: workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    const calls: string[] = [];
    let outstanding = 0;
    let maximumOutstanding = 0;
    const healthyInspected = deferred();
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      inspectionTimeoutMs: 30,
      inspectDirectory: async (targetPath) => {
        calls.push(targetPath);
        maximumOutstanding = Math.max(maximumOutstanding, ++outstanding);
        if (path.basename(targetPath) === "hung") return new Promise(() => {});
        healthyInspected.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        outstanding--;
        return "directory";
      },
    });
    try {
      const scan = service.runOnce();
      await Promise.race([
        healthyInspected.promise,
        scan.then(() => {
          throw new Error("Reconciliation did not use its directory inspection capability");
        }),
      ]);
      expect(outstanding).toBeLessThanOrEqual(2);
      expect(workspaces.get("hung")?.archivedAt).toBeNull();
      const result = await scan;
      expect(result.changesApplied).toEqual([]);
      await service.runOnce();
      expect(calls.filter((cwd) => path.basename(cwd) === "hung")).toHaveLength(1);
      expect(calls.filter((cwd) => path.basename(cwd) === "healthy3")).toHaveLength(2);
      expect(maximumOutstanding).toBe(2);
      expect([...workspaces.values()].map((workspace) => workspace.archivedAt)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    } finally {
      service.dispose();
    }
  });

  test.each(["missing", "directory"] as const)(
    "does not process or archive a workspace archived during %s inspection",
    async (state) => {
      const rootPath = realpathSync(
        mkdtempSync(path.join(tmpdir(), "reconcile-inspection-archive-")),
      );
      tempDirs.push(rootPath);
      const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
      projects.set(
        "p1",
        createPersistedProjectRecord({
          projectId: "p1",
          rootPath,
          projectKey: canonicalLocalProjectKey(rootPath),
          kind: "non_git",
          displayName: "project",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      const cwd = path.join(rootPath, "missing");
      workspaces.set(
        "w1",
        createPersistedWorkspaceRecord({
          workspaceId: "w1",
          projectId: "p1",
          cwd,
          kind: "directory",
          displayName: "workspace",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      const started = deferred();
      const release = deferred();
      const archivedCallbacks: string[] = [];
      const checkouts = new TestCheckouts();
      const service = new WorkspaceReconciliationService({
        projectRegistry,
        workspaceRegistry,
        logger: createTestLogger(),
        workspaceGitService: checkouts,
        onWorkspaceArchived: (id) => {
          archivedCallbacks.push(id);
        },
        inspectDirectory: async (targetPath) => {
          if (targetPath === cwd) {
            started.resolve();
            await release.promise;
            return state;
          }
          return "directory";
        },
      });
      try {
        const scan = service.runOnce();
        await Promise.race([
          started.promise,
          scan.then(() => {
            throw new Error("Reconciliation did not use its directory inspection capability");
          }),
        ]);
        await workspaceRegistry.archive("w1", "2026-01-01T00:00:00.000Z");
        const archived = workspaces.get("w1");
        release.resolve();
        const result = await scan;
        expect(workspaces.get("w1")).toEqual(archived);
        expect(archivedCallbacks).toEqual([]);
        expect(checkouts.reads).toEqual([rootPath]);
        expect(result.changesApplied).toEqual([]);
      } finally {
        release.resolve();
        service.dispose();
      }
    },
  );

  test("keeps the event loop responsive while inspecting 20000 real workspace paths", async () => {
    const rootPath = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-many-")));
    tempDirs.push(rootPath);
    // Unrelated runner work must not consume the reconciliation budget.
    const unrelatedWork = new Promise<void>((resolve) => {
      setImmediate(() => {
        const cpu = Reflect.get(process, "threadCpuUsage") as typeof process.cpuUsage;
        const start = cpu();
        while (cpu(start).user + cpu(start).system < 80_000) {}
        resolve();
      });
    });
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [probePath, rootPath], {
      timeout: 25_000,
    });
    process.stderr.write(stderr);
    const { changesApplied, blockingMs, filesystemRequests, allArchived } = JSON.parse(stdout) as {
      changesApplied: number;
      blockingMs: number;
      filesystemRequests: number;
      allArchived: boolean;
    };
    await unrelatedWork;
    expect(blockingMs).toBeLessThan(20);
    expect(filesystemRequests).toBe(20001);
    expect(changesApplied).toBe(20000);
    expect(allArchived).toBe(true);
  }, 30000);

  test("preserves workspace archival that lands during boot reconciliation", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-archive-race-")));
    tempDirs.push(workspaceRoot);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: workspaceRoot,
        kind: "git",
        displayName: "archive-race",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: workspaceRoot,
        kind: "local_checkout",
        displayName: "archive-race",
        branch: "old-branch",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const readStarted = deferred();
    const allowRead = deferred();
    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
      workspaceGitService: {
        getCheckout: async (cwd) => {
          readStarted.resolve();
          await allowRead.promise;
          return createCheckout(cwd, {
            isGit: true,
            currentBranch: "new-branch",
            worktreeRoot: cwd,
          });
        },
      },
    });

    const reconciliation = service.reconcileGitMetadata();
    await readStarted.promise;
    const archivedAt = "2025-01-02T00:00:00.000Z";
    await workspaceRegistry.archive("w1", archivedAt);
    allowRead.resolve();
    await reconciliation;

    expect(workspaces.get("w1")).toMatchObject({
      archivedAt,
      branch: "new-branch",
    });
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
    const projectKey = deriveProjectKey({
      rootPath: projectRoot,
      remoteUrl: null,
      worktreeRoot: null,
      mainRepoRoot: null,
    });

    expect(metadataResult.changesApplied).toEqual([
      {
        kind: "project_updated",
        projectId: "p1",
        directory: projectRoot,
        fields: { projectKey },
      },
    ]);
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
    const projectKey = deriveProjectKey({
      rootPath: projectRoot,
      remoteUrl: null,
      worktreeRoot: null,
      mainRepoRoot: null,
    });

    expect(beforeGitInit.changesApplied).toEqual([
      {
        kind: "project_updated",
        projectId: "p1",
        directory: projectRoot,
        fields: { projectKey },
      },
    ]);
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

    expect(result.changesApplied).toEqual([
      {
        kind: "project_updated",
        projectId: "p1",
        directory: projectRoot,
        fields: { projectKey: canonicalLocalProjectKey(projectRoot) },
      },
      {
        kind: "project_updated",
        projectId: "p2",
        directory: equivalentProjectRoot,
        fields: { projectKey: canonicalLocalProjectKey(projectRoot) },
      },
    ]);
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
          fields: { kind: "git", projectKey: canonicalLocalProjectKey(projectRoot) },
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
      projectKey: canonicalLocalProjectKey(projectRoot),
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
    const projectRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "reconcile-missing-workspace-")),
    );
    const missingWorkspace = path.join(projectRoot, "missing-workspace");
    tempDirs.push(projectRoot);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    const archivedWorkspaceIds: string[] = [];

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: projectRoot,
        projectKey: canonicalLocalProjectKey(projectRoot),
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
        cwd: missingWorkspace,
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
      onWorkspaceArchived: (workspaceId) => {
        archivedWorkspaceIds.push(workspaceId);
      },
    });

    const result = await service.runOnce();

    expect(result.changesApplied).toEqual([
      {
        kind: "workspace_archived",
        workspaceId: "w1",
        directory: missingWorkspace,
        reason: "directory_missing",
      },
    ]);
    expect(archivedWorkspaceIds).toEqual(["w1"]);
    expect(workspaces.get("w1")?.archivedAt).toEqual(expect.any(String));
  });

  test("keeps workspaces whose project root is missing with them", async () => {
    const mountParent = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-unmounted-")));
    tempDirs.push(mountParent);
    // The external volume is not mounted, so nothing under it resolves.
    const projectRoot = path.join(mountParent, "ExternalSSD", "repo");
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: projectRoot,
        kind: "non_git",
        displayName: "repo",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    workspaces.set(
      "w1",
      createPersistedWorkspaceRecord({
        workspaceId: "w1",
        projectId: "p1",
        cwd: projectRoot,
        kind: "directory",
        displayName: "repo",
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

    expect(result.changesApplied).toEqual([]);
    expect(workspaces.get("w1")?.archivedAt).toBeNull();
  });

  test("keeps a project active after all its workspaces are archived", async () => {
    const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-orphan-project-")));
    const missingWorkspace = path.join(projectRoot, "missing-workspace");
    tempDirs.push(projectRoot);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    const project = createPersistedProjectRecord({
      projectId: "p1",
      rootPath: projectRoot,
      projectKey: canonicalLocalProjectKey(projectRoot),
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
        cwd: missingWorkspace,
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
        directory: missingWorkspace,
        reason: "directory_missing",
      },
    ]);
    expect(workspaces.get("w1")).toEqual({
      workspaceId: "w1",
      projectId: "p1",
      cwd: missingWorkspace,
      kind: "directory",
      displayName: "orphan",
      background: false,
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
      autoArchivedChangeRequestUrl: null,
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
      "project_updated",
      "project_updated",
      "workspace_updated",
      "workspace_updated",
    ]);
    expect(projects.get("remote:github.com/blank-dot-page/editor")).toMatchObject({
      projectId: "remote:github.com/blank-dot-page/editor",
      rootPath: repoDir,
      displayName: "blank-dot-page/editor",
      customName: null,
      projectKey: "remote:github.com/blank-dot-page/editor",
      archivedAt: null,
    });
    expect(projects.get(repoDir)).toMatchObject({
      projectId: repoDir,
      rootPath: repoDir,
      displayName: "editor",
      customName: "Editor",
      projectKey: "remote:github.com/blank-dot-page/editor",
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

  test("backfills a missing project key while keeping the project display name stable", async () => {
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

    expect(result.changesApplied.find((c) => c.kind === "project_updated")).toMatchObject({
      fields: { projectKey: "remote:github.com/new-owner/new-repo" },
    });
    expect(projects.get("p1")!.displayName).toBe("old-owner/old-repo");
    expect(projects.get("p1")!.projectKey).toBe("remote:github.com/new-owner/new-repo");
  });

  test("refreshes an empty project's persisted key when its Git remote changes", async () => {
    const dir = createTempGitRepo("reconcile-empty-remote-change-");
    tempDirs.push(dir);
    const { projects, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        projectKey: "remote:github.com/old-owner/old-repo",
        rootPath: dir,
        kind: "git",
        displayName: "old-owner/old-repo",
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
          projectDisplayName: "new-owner/new-repo",
          workspaceDisplayName: "main",
          gitRemote: "git@github.com:new-owner/new-repo.git",
        },
      }),
    });

    const result = await service.runOnce();

    expect(result.changesApplied).toEqual([
      expect.objectContaining({
        kind: "project_updated",
        fields: { projectKey: "remote:github.com/new-owner/new-repo" },
      }),
    ]);
    expect(projects.get("p1")?.projectKey).toBe("remote:github.com/new-owner/new-repo");
  });

  test("refreshes a persisted project key when a Git remote disappears", async () => {
    const dir = createTempGitRepo("reconcile-removed-remote-");
    tempDirs.push(dir);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        projectKey: "remote:github.com/acme/old-repo",
        rootPath: dir,
        kind: "git",
        displayName: "acme/old-repo",
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
          projectDisplayName: "old-repo",
          workspaceDisplayName: "main",
          gitRemote: null,
        },
      }),
    });

    await service.runOnce();

    expect(projects.get("p1")?.projectKey).toBe(canonicalLocalProjectKey(dir));
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
        fields: { kind: "git", projectKey: canonicalLocalProjectKey(projectRoot) },
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
    const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-callback-")));
    const missingWorkspace = path.join(projectRoot, "missing-workspace");
    tempDirs.push(projectRoot);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: projectRoot,
        projectKey: canonicalLocalProjectKey(projectRoot),
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
        cwd: missingWorkspace,
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
        directory: missingWorkspace,
        reason: "directory_missing",
      },
    ]);
  });

  test("logs reconciliation changes with affected paths and reasons", async () => {
    const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "reconcile-log-")));
    const missingWorkspace = path.join(projectRoot, "missing-workspace");
    tempDirs.push(projectRoot);
    const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
    const { logger, infoRecords } = createCapturingLogger();

    projects.set(
      "p1",
      createPersistedProjectRecord({
        projectId: "p1",
        rootPath: projectRoot,
        projectKey: canonicalLocalProjectKey(projectRoot),
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
        cwd: missingWorkspace,
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
              directory: missingWorkspace,
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
        kind: "project_updated",
        projectId: "p1",
        directory: rootPath,
        fields: { projectKey: canonicalLocalProjectKey(rootPath) },
      },
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
