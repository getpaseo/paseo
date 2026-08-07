import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getWorkspaceGitSelfHealPhaseMs } from "./workspace-git-service.js";
import {
  configureGitProcessPolicy,
  snapshotGitCommandRuntimeMetrics,
  type GitCommandSubmissionMetric,
  startGitCommandMetrics,
  stopGitCommandMetrics,
  waitForGitCommandMetricsIdle,
} from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";

const SIBLING_COUNT = 100;
const CREATED_AT = "2026-08-07T00:00:00.000Z";
const originalMaxProcessesPerSecond = process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND;

let daemon: TestPaseoDaemon | null = null;
let client: DaemonClient | null = null;
const cleanupPaths: string[] = [];

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await daemon?.close().catch(() => undefined);
  client = null;
  daemon = null;
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  if (originalMaxProcessesPerSecond === undefined) {
    delete process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND;
  } else {
    process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND = originalMaxProcessesPerSecond;
  }
  configureGitProcessPolicy(resolveGitProcessPolicy({ env: process.env }));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function seedFixture(siblingCount = SIBLING_COUNT): {
  repoRoot: string;
  paseoHomeRoot: string;
  projectId: string;
  siblingWorktrees: string[];
} {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "paseo-workspace-create-fanout-"));
  cleanupPaths.push(fixtureRoot);
  const repoRoot = join(fixtureRoot, "repo");
  const worktreesRoot = join(fixtureRoot, "siblings");
  const paseoHomeRoot = join(fixtureRoot, "home");
  const projectsDir = join(paseoHomeRoot, ".paseo", "projects");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "repro@example.com");
  git(repoRoot, "config", "user.name", "Repro");
  writeFileSync(join(repoRoot, "README.md"), "repro\n");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "initial");

  const projectId = "proj-fanout-repro";
  const workspaces = [];
  const siblingWorktrees = [];
  for (let index = 0; index < siblingCount; index += 1) {
    let suffix = 0;
    let branch = `sibling-${index}-${suffix}`;
    let cwd = join(worktreesRoot, branch);
    while (getWorkspaceGitSelfHealPhaseMs(cwd) < 30_000) {
      suffix += 1;
      branch = `sibling-${index}-${suffix}`;
      cwd = join(worktreesRoot, branch);
    }
    git(repoRoot, "worktree", "add", "-b", branch, cwd, "HEAD");
    siblingWorktrees.push(cwd);
    workspaces.push({
      workspaceId: `ws-sibling-${index}`,
      projectId,
      cwd,
      kind: "worktree",
      displayName: branch,
      title: null,
      branch,
      worktreeRoot: cwd,
      baseBranch: "main",
      isPaseoOwnedWorktree: false,
      mainRepoRoot: repoRoot,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      archivedAt: null,
      autoArchivedChangeRequestUrl: null,
      pinnedAt: null,
    });
  }

  writeFileSync(
    join(projectsDir, "projects.json"),
    JSON.stringify([
      {
        projectId,
        rootPath: repoRoot,
        kind: "git",
        displayName: "repo",
        projectKey: null,
        customName: null,
        customIconRevision: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
      },
    ]),
  );
  writeFileSync(join(projectsDir, "workspaces.json"), JSON.stringify(workspaces));
  return { repoRoot, paseoHomeRoot, projectId, siblingWorktrees };
}

async function startObservedFixture(siblingCount: number): Promise<ReturnType<typeof seedFixture>> {
  const fixture = seedFixture(siblingCount);
  daemon = await createTestPaseoDaemon({
    paseoHomeRoot: fixture.paseoHomeRoot,
    cleanup: false,
    mcpEnabled: false,
  });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "agents" } });
  await client.fetchWorkspaces({
    page: { limit: 200 },
    subscribe: { subscriptionId: "workspaces" },
  });
  return fixture;
}

interface GitRuntimeExpectation {
  currentBranch?: string;
  remoteUrl?: string;
  isDirty?: boolean;
  additions?: number;
  deletions?: number;
  ahead?: number;
  aheadOfOrigin?: number;
  behindOfOrigin?: number;
}

function matchesGitRuntime(
  workspace: WorkspaceDescriptorPayload,
  expected: GitRuntimeExpectation,
): boolean {
  const actual: Record<keyof GitRuntimeExpectation, unknown> = {
    currentBranch: workspace.gitRuntime?.currentBranch,
    remoteUrl: workspace.gitRuntime?.remoteUrl,
    isDirty: workspace.gitRuntime?.isDirty,
    additions: workspace.diffStat?.additions,
    deletions: workspace.diffStat?.deletions,
    ahead: workspace.gitRuntime?.aheadBehind?.ahead,
    aheadOfOrigin: workspace.gitRuntime?.aheadOfOrigin,
    behindOfOrigin: workspace.gitRuntime?.behindOfOrigin,
  };
  return (Object.entries(expected) as Array<[keyof GitRuntimeExpectation, unknown]>).every(
    ([key, value]) => actual[key] === value,
  );
}

function waitForWorkspaceGitRuntime(
  workspaceId: string,
  expected: GitRuntimeExpectation,
): Promise<void> {
  if (!client) throw new Error("Daemon client is not connected");
  const activeClient = client;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for Git runtime update for ${workspaceId}`));
    }, 15_000);
    const unsubscribe = activeClient.subscribe((event) => {
      if (event.type !== "workspace_update" || event.payload.kind !== "upsert") return;
      const workspace = event.payload.workspace;
      if (workspace.id !== workspaceId || !matchesGitRuntime(workspace, expected)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

function countGitOperations(commands: GitCommandSubmissionMetric[]): Record<string, number> {
  return Object.fromEntries(
    [...Map.groupBy(commands, (command) => command.args[0] ?? "").entries()]
      .map(([operation, matchingCommands]) => [operation, matchingCommands.length] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function settleGitCommands(): Promise<void> {
  startGitCommandMetrics();
  await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
  stopGitCommandMetrics();
}

async function measureGitCommands(operation: () => void | Promise<void>) {
  startGitCommandMetrics();
  await operation();
  await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
  return stopGitCommandMetrics();
}

function waitForCheckoutDiffFiles(subscriptionId: string, expectedPaths: string[]): Promise<void> {
  if (!client) {
    throw new Error("Daemon client is not connected");
  }
  const activeClient = client;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for checkout diff ${subscriptionId}`));
    }, 15_000);
    const unsubscribe = activeClient.on("checkout_diff_update", (message) => {
      if (message.type !== "checkout_diff_update") {
        return;
      }
      const payload = message.payload;
      if (payload.subscriptionId !== subscriptionId) {
        return;
      }
      const paths = payload.files.map((file) => file.path);
      if (JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

test.each([1, 2, 10])(
  "coalesces working-file and index events for one of %i observed sibling worktrees",
  async (siblingCount) => {
    configureGitProcessPolicy({ maxProcessConcurrency: 8, maxProcessesPerSecond: 64 });
    const fixture = await startObservedFixture(siblingCount);
    startGitCommandMetrics();
    await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
    stopGitCommandMetrics();

    startGitCommandMetrics();
    const dirtyUpdate = waitForWorkspaceGitRuntime("ws-sibling-0", {
      isDirty: true,
      additions: 1,
      deletions: 1,
    });
    writeFileSync(join(fixture.siblingWorktrees[0] ?? "", "README.md"), "staged change\n");
    git(fixture.siblingWorktrees[0] ?? "", "add", "README.md");
    await dirtyUpdate;
    await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
    const staging = stopGitCommandMetrics();

    expect(staging.submissions.map((command) => command.args[0]).sort()).toEqual([
      "branch",
      "config",
      "config",
      "config",
      "diff",
      "for-each-ref",
      "ls-files",
      "merge-base",
      "rev-list",
      "rev-parse",
      "rev-parse",
      "rev-parse",
      "rev-parse",
      "rev-parse",
      "show-ref",
      "show-ref",
      "status",
      "symbolic-ref",
    ]);
    const changedWorktree = realpathSync(fixture.siblingWorktrees[0] ?? "");
    expect(staging.submissions.map((command) => realpathSync(command.cwd))).toEqual(
      Array.from({ length: 18 }, () => changedWorktree),
    );
  },
  120_000,
);

test.each([false, true])(
  "records unchanged index metadata work with base diff subscribed: %s",
  async (hasBaseDiffSubscription) => {
    configureGitProcessPolicy({ maxProcessConcurrency: 8, maxProcessesPerSecond: 64 });
    const fixture = await startObservedFixture(2);

    startGitCommandMetrics();
    await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
    stopGitCommandMetrics();

    if (hasBaseDiffSubscription) {
      await client?.subscribeCheckoutDiff(
        fixture.siblingWorktrees[0] ?? "",
        { mode: "base", baseRef: "main" },
        { subscriptionId: "base-diff" },
      );
      startGitCommandMetrics();
      await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
      stopGitCommandMetrics();
    }

    startGitCommandMetrics();
    git(fixture.siblingWorktrees[0] ?? "", "update-index", "--index-version=4");
    await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
    const metadataUpdate = stopGitCommandMetrics();

    expect(metadataUpdate.submitted).toBe(18);
    expect(countGitOperations(metadataUpdate.submissions)).toEqual({
      branch: 1,
      config: 3,
      diff: 1,
      "for-each-ref": 1,
      "ls-files": 1,
      "merge-base": 1,
      "rev-list": 1,
      "rev-parse": 5,
      "show-ref": 2,
      status: 1,
      "symbolic-ref": 1,
    });
    const changedWorktree = realpathSync(fixture.siblingWorktrees[0] ?? "");
    expect(metadataUpdate.submissions.map((command) => realpathSync(command.cwd))).toEqual(
      Array.from({ length: 18 }, () => changedWorktree),
    );
  },
  120_000,
);

test.each([1, 2, 10])(
  "records the Git command budget of creating a workspace with %i warm siblings",
  async (siblingCount) => {
    configureGitProcessPolicy({ maxProcessConcurrency: 8, maxProcessesPerSecond: 64 });
    const fixture = await startObservedFixture(siblingCount);
    startGitCommandMetrics();
    await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
    stopGitCommandMetrics();

    startGitCommandMetrics();
    const response = await client?.createWorkspace({
      source: {
        kind: "worktree",
        cwd: fixture.repoRoot,
        projectId: fixture.projectId,
        action: "branch-off",
        refName: "main",
        branchName: "created-during-measurement",
        worktreeSlug: "created-during-measurement",
      },
    });
    await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
    const creation = stopGitCommandMetrics();

    expect(response?.workspace?.name).toBe("created-during-measurement");
    expect(creation.submitted).toBe(90);
    expect(countGitOperations(creation.submissions)).toEqual({
      branch: 4,
      config: 19,
      diff: 2,
      "for-each-ref": 6,
      "ls-files": 3,
      "merge-base": 2,
      "rev-list": 2,
      "rev-parse": 34,
      "show-ref": 6,
      status: 6,
      "symbolic-ref": 4,
      worktree: 2,
    });
    const existingWorktrees = new Set(fixture.siblingWorktrees.map((cwd) => realpathSync(cwd)));
    expect(
      creation.submissions.filter((command) => existingWorktrees.has(realpathSync(command.cwd))),
    ).toEqual([]);
  },
  120_000,
);

test("refreshes every workspace that depends on a changed shared base ref", async () => {
  configureGitProcessPolicy({ maxProcessConcurrency: 8, maxProcessesPerSecond: 64 });
  const fixture = await startObservedFixture(2);
  startGitCommandMetrics();
  await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
  stopGitCommandMetrics();

  const changedWorktree = fixture.siblingWorktrees[0] ?? "";
  writeFileSync(join(changedWorktree, "README.md"), "branch change\n");
  git(changedWorktree, "add", "README.md");
  git(changedWorktree, "commit", "-m", "branch change");
  startGitCommandMetrics();
  await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
  stopGitCommandMetrics();

  const subscriptionId = "shared-base-ref-diff";
  const initial = await client?.subscribeCheckoutDiff(
    changedWorktree,
    { mode: "base", baseRef: "main" },
    { subscriptionId },
  );
  expect(initial?.files.map((file) => file.path)).toEqual(["README.md"]);
  startGitCommandMetrics();
  await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
  stopGitCommandMetrics();

  const changedHead = git(changedWorktree, "rev-parse", "HEAD");
  const emptyDiffUpdate = waitForCheckoutDiffFiles(subscriptionId, []);
  startGitCommandMetrics();
  git(fixture.repoRoot, "update-ref", "refs/heads/main", changedHead);
  await emptyDiffUpdate;
  await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 30_000 });
  const sharedRefUpdate = stopGitCommandMetrics();

  expect(sharedRefUpdate.submitted).toBe(43);
  expect(countGitOperations(sharedRefUpdate.submissions)).toEqual({
    branch: 3,
    config: 6,
    diff: 3,
    "for-each-ref": 2,
    "ls-files": 2,
    "merge-base": 3,
    "rev-list": 2,
    "rev-parse": 11,
    "show-ref": 6,
    status: 2,
    "symbolic-ref": 3,
  });
  client?.unsubscribeCheckoutDiff(subscriptionId);
}, 120_000);

test("records the Git command ledger for repository metadata business rules", async () => {
  configureGitProcessPolicy({ maxProcessConcurrency: 8, maxProcessesPerSecond: 64 });
  const fixture = await startObservedFixture(2);
  await settleGitCommands();

  const firstWorktree = fixture.siblingWorktrees[0] ?? "";
  const firstGitDir = git(firstWorktree, "rev-parse", "--absolute-git-dir");
  const externalWorktree = join(fixture.repoRoot, "..", "external-worktree");

  const privateNoise = await measureGitCommands(() => {
    writeFileSync(join(firstGitDir, "COMMIT_EDITMSG"), "ignored message\n");
  });
  const unrelatedWorktreeAdd = await measureGitCommands(() => {
    git(fixture.repoRoot, "worktree", "add", "-b", "external-worktree", externalWorktree, "main");
  });

  writeFileSync(join(firstWorktree, "README.md"), "committed change\n");
  git(firstWorktree, "add", "README.md");
  await settleGitCommands();
  const committedUpdate = waitForWorkspaceGitRuntime("ws-sibling-0", { ahead: 1 });
  const ownCommit = await measureGitCommands(() => {
    git(firstWorktree, "commit", "-m", "measured commit");
  });
  await committedUpdate;

  git(firstWorktree, "branch", "measured-switch", "main");
  await settleGitCommands();
  const switchedUpdate = waitForWorkspaceGitRuntime("ws-sibling-0", {
    currentBranch: "measured-switch",
    ahead: 0,
  });
  const ownBranchSwitch = await measureGitCommands(() => {
    git(firstWorktree, "switch", "measured-switch");
  });
  await switchedUpdate;

  const configUpdates = [
    waitForWorkspaceGitRuntime("ws-sibling-0", { remoteUrl: fixture.repoRoot }),
    waitForWorkspaceGitRuntime("ws-sibling-1", { remoteUrl: fixture.repoRoot }),
  ];
  const sharedConfig = await measureGitCommands(() => {
    git(fixture.repoRoot, "remote", "add", "origin", fixture.repoRoot);
  });
  await Promise.all(configUpdates);
  git(fixture.repoRoot, "config", "branch.measured-switch.remote", "origin");
  git(fixture.repoRoot, "config", "branch.measured-switch.merge", "refs/heads/measured-switch");
  await settleGitCommands();
  const trackingUpdate = waitForWorkspaceGitRuntime("ws-sibling-0", {
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
  });
  const remoteTrackingRef = await measureGitCommands(() => {
    const head = git(firstWorktree, "rev-parse", "measured-switch");
    git(fixture.repoRoot, "update-ref", "refs/remotes/origin/measured-switch", head);
  });
  await trackingUpdate;
  const packedRefs = await measureGitCommands(() => {
    git(fixture.repoRoot, "pack-refs", "--all", "--prune");
  });

  const commandLedger = {
    privateNoise: privateNoise.submitted,
    unrelatedWorktreeAdd: unrelatedWorktreeAdd.submitted,
    ownCommit: ownCommit.submitted,
    ownBranchSwitch: ownBranchSwitch.submitted,
    remoteTrackingRef: remoteTrackingRef.submitted,
    sharedConfig: sharedConfig.submitted,
    packedRefs: packedRefs.submitted,
  };
  expect(commandLedger).toEqual({
    privateNoise: 0,
    unrelatedWorktreeAdd: 0,
    ownCommit: 18,
    ownBranchSwitch: 18,
    remoteTrackingRef: 19,
    sharedConfig: 36,
    packedRefs: 37,
  });

  const ownerOperations = {
    branch: 1,
    config: 3,
    diff: 1,
    "for-each-ref": 1,
    "ls-files": 1,
    "merge-base": 1,
    "rev-list": 1,
    "rev-parse": 5,
    "show-ref": 2,
    status: 1,
    "symbolic-ref": 1,
  };
  expect(countGitOperations(ownCommit.submissions)).toEqual(ownerOperations);
  expect(countGitOperations(ownBranchSwitch.submissions)).toEqual(ownerOperations);
  expect(countGitOperations(remoteTrackingRef.submissions)).toEqual({
    ...ownerOperations,
    config: 4,
  });
  expect(countGitOperations(sharedConfig.submissions)).toEqual(
    Object.fromEntries(
      Object.entries(ownerOperations).map(([operation, count]) => [operation, count * 2]),
    ),
  );
  expect(countGitOperations(packedRefs.submissions)).toEqual({
    ...Object.fromEntries(
      Object.entries(ownerOperations).map(([operation, count]) => [operation, count * 2]),
    ),
    config: 7,
  });

  const firstWorktreeRoot = realpathSync(firstWorktree);
  const secondWorktreeRoot = realpathSync(fixture.siblingWorktrees[1] ?? "");
  for (const measurement of [ownCommit, ownBranchSwitch, remoteTrackingRef]) {
    expect(new Set(measurement.submissions.map((command) => realpathSync(command.cwd)))).toEqual(
      new Set([firstWorktreeRoot]),
    );
  }
  for (const measurement of [sharedConfig, packedRefs]) {
    expect(new Set(measurement.submissions.map((command) => realpathSync(command.cwd)))).toEqual(
      new Set([firstWorktreeRoot, secondWorktreeRoot]),
    );
  }
}, 120_000);

test("workspace archive is admitted while 52 sibling observations hydrate", async () => {
  configureGitProcessPolicy({ maxProcessConcurrency: 8, maxProcessesPerSecond: 64 });
  const fixture = seedFixture(52);
  daemon = await createTestPaseoDaemon({
    paseoHomeRoot: fixture.paseoHomeRoot,
    cleanup: false,
    mcpEnabled: false,
  });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "agents" } });
  const created = await client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: fixture.repoRoot,
      projectId: fixture.projectId,
      action: "branch-off",
      refName: "main",
      branchName: "archive-during-hydration",
      worktreeSlug: "archive-during-hydration",
    },
  });
  const workspaceId = created.workspace?.id;
  expect(workspaceId).toBeTypeOf("string");

  await client.fetchWorkspaces({
    page: { limit: 200 },
    subscribe: { subscriptionId: "workspaces" },
  });
  expect(snapshotGitCommandRuntimeMetrics().pending).toBeGreaterThan(0);
  const archiveStartedAt = Date.now();
  const archived = await client.archiveWorkspace(workspaceId ?? "");

  expect(archived.error).toBeNull();
  expect(archived.archivedAt).not.toBeNull();
  expect(Date.now() - archiveStartedAt).toBeLessThan(30_000);
}, 180_000);

test("workspace create is admitted while 100 sibling observations hydrate", async () => {
  process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND = "64";
  configureGitProcessPolicy({ maxProcessConcurrency: 8, maxProcessesPerSecond: 64 });
  const fixture = seedFixture();
  daemon = await createTestPaseoDaemon({
    paseoHomeRoot: fixture.paseoHomeRoot,
    cleanup: false,
    mcpEnabled: false,
  });
  configureGitProcessPolicy({ maxProcessConcurrency: 8, maxProcessesPerSecond: 64 });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "agents" } });
  const snapshot = await client.fetchWorkspaces({
    page: { limit: 200 },
    subscribe: { subscriptionId: "workspaces" },
  });
  expect(snapshot.entries).toHaveLength(SIBLING_COUNT);
  expect(snapshotGitCommandRuntimeMetrics().pending).toBeGreaterThan(0);

  const createStartedAt = Date.now();
  const createPromise = client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: fixture.repoRoot,
      projectId: fixture.projectId,
      action: "branch-off",
      refName: "main",
      branchName: "created-during-repro",
      worktreeSlug: "created-during-repro",
    },
  });
  const response = await createPromise;
  expect(response.error).toBeNull();
  expect(response.workspace?.name).toBe("created-during-repro");
  expect(Date.now() - createStartedAt).toBeLessThan(30_000);
}, 180_000);
