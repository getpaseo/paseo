import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { DaemonClient } from "./test-utils/index.js";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DaemonClient as SocketDaemonClient,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// The reshaped workspace.create.request forwards its worktree `source`
// (action/refName/branchName/githubPrNumber/worktreeSlug) into createWorktreeCore.
// The regression these tests guard against is the daemon dropping action/refName
// while subsetting the request. We prove forwarding through the real workflow:
// the created worktree's observable branch is the only honest evidence the
// request fields reached git.

function createGitRepoWithBranch(): { repoDir: string; tempRoot: string } {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "workspace-create-worktree-source-"));
  const repoDir = path.join(tempRoot, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  // An existing branch the checkout action must target by refName.
  execFileSync("git", ["branch", "feature/existing-branch"], { cwd: repoDir, stdio: "pipe" });
  return { repoDir, tempRoot };
}

test("workspace.create worktree source forwards action=checkout + refName into the real worktree", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const result = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "checkout",
        refName: "feature/existing-branch",
      },
    });

    expect(result.error).toBeNull();
    // If action/refName were dropped, the daemon would branch-off a generated
    // slug instead of checking out the named branch. The created worktree being
    // on feature/existing-branch is the observable proof both fields forwarded.
    expect(result.workspace?.gitRuntime?.currentBranch).toBe("feature/existing-branch");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 180000);

test.each([false, true])(
  "workspace.create opens worktree.terminals (setup service: %s)",
  async (withSetupService) => {
    const daemon = await createTestPaseoDaemon();
    const { repoDir, tempRoot } = createGitRepoWithBranch();
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          ...(withSetupService
            ? {
                // Launch the Windows service asynchronously so it outlives
                // the setup command instead of holding setup open.
                setup:
                  process.platform === "win32"
                    ? "Start-Process -FilePath node -ArgumentList 'setup.cjs','serve' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden; while (!(Test-Path setup-pid.txt)) { Start-Sleep -Milliseconds 25 }"
                    : "node setup.cjs",
              }
            : {}),
          terminals: [
            { name: "preview", command: "echo paseo-auto-terminal >> terminal-marker.txt" },
          ],
        },
      }),
    );
    writeFileSync(
      path.join(repoDir, "setup.cjs"),
      `
const fs = require("node:fs");
if (process.argv[2] === "serve") {
  require("node:net").createServer().listen(Number(process.env.PASEO_WORKTREE_PORT), "127.0.0.1", () => {
    fs.writeFileSync("setup-pid.txt", String(process.pid));
    process.send?.("ready");
  });
} else {
  const child = require("node:child_process").spawn(process.execPath, [__filename, "serve"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", () => { child.disconnect(); child.unref(); });
}
`,
    );
    execFileSync("git", ["add", "paseo.json", "setup.cjs"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add paseo.json"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.82",
    });

    let workspaceCwd: string | undefined;
    try {
      await client.connect();

      // This is the request the New Workspace screen sends: the workspace is
      // created on its own, with no agent in the same request.
      const result = await client.createWorkspace({
        source: {
          kind: "worktree",
          cwd: repoDir,
          action: "branch-off",
          branchName: "feature/auto-terminals",
          worktreeSlug: "feature-auto-terminals",
          baseBranch: "main",
        },
      });

      expect(result.error).toBeNull();
      const workspace = result.workspace;
      if (!workspace) {
        throw new Error("Expected a created workspace");
      }

      workspaceCwd = workspace.workspaceDirectory;
      if (withSetupService) {
        await expect
          .poll(() => existsSync(path.join(workspaceCwd!, "setup-pid.txt")), { timeout: 30000 })
          .toBe(true);
      }
      await expect
        .poll(async () => (await client.fetchWorkspaceSetupStatus(workspace.id)).snapshot, {
          timeout: 30000,
        })
        .toMatchObject({ status: "completed", error: null });
      await expect
        .poll(
          async () =>
            (
              await client.listTerminals(workspace.workspaceDirectory, undefined, {
                workspaceId: workspace.id,
              })
            ).terminals.map((terminal) => terminal.name),
          { timeout: 30000 },
        )
        .toContain("preview");
      await expect
        .poll(
          () => {
            const marker = path.join(workspaceCwd!, "terminal-marker.txt");
            return existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
          },
          { timeout: 10000 },
        )
        .toBe("paseo-auto-terminal");
      expect(
        (await client.listTerminals(workspaceCwd, undefined, { workspaceId: workspace.id }))
          .terminals,
      ).toHaveLength(1);
    } finally {
      const pidFile = workspaceCwd && path.join(workspaceCwd, "setup-pid.txt");
      if (pidFile && existsSync(pidFile)) {
        process.kill(Number(readFileSync(pidFile, "utf8")));
      }
      await client.close().catch(() => undefined);
      await daemon.close();
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  180000,
);

test("existing branch changes remain visible after archive and restore", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.2",
  });
  onTestFinished(async () => {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  runGit(repoDir, "switch", "feature/existing-branch");
  commitFile(repoDir, "feature.txt", "feature change\n");
  runGit(repoDir, "switch", "main");
  await client.connect();
  const created = await client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: repoDir,
      action: "checkout",
      refName: "feature/existing-branch",
    },
  });
  expect(created.error).toBeNull();
  const workspace = created.workspace!;
  const cwd = workspace.workspaceDirectory;
  const head = runGit(cwd, "rev-parse", "HEAD");
  const before = await client.getCheckoutDiff(cwd, { mode: "base" });
  expect(before.error).toBeNull();
  expect(before.files.map((file) => file.path)).toEqual(["feature.txt"]);
  expect((await client.getCheckoutStatus(cwd)).baseRef).toBe("main");
  expect((await client.archiveWorkspace(workspace.id)).error).toBeNull();
  expect(existsSync(cwd)).toBe(false);
  await client.restoreWorkspace(workspace.id);
  expect(runGit(cwd, "rev-parse", "HEAD")).toBe(head);
  expect((await client.getCheckoutStatus(cwd)).baseRef).toBe("main");
  const after = await client.getCheckoutDiff(cwd, { mode: "base" });
  expect(after.error).toBeNull();
  expect(after.files.map((file) => file.path)).toEqual(["feature.txt"]);
}, 180000);

test("workspace.create keeps a branch-off name separate from its worktree slug", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const result = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        branchName: "feature/auth",
        worktreeSlug: "feature-auth",
        baseBranch: "main",
      },
    });

    expect(result.error).toBeNull();
    expect(result.workspace?.gitRuntime?.currentBranch).toBe("feature/auth");
    expect(path.basename(result.workspace?.workspaceDirectory ?? "")).toBe("feature-auth");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 180000);

test("workspace.create accepts a Git-valid branch-off name outside Paseo slug syntax", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const result = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        branchName: "ABC-123_Fix-Broken-Model-Relationships_Author_Name",
        worktreeSlug: "git-valid-branch-name",
        baseBranch: "main",
      },
    });

    expect(result.error).toBeNull();
    expect(result.workspace?.gitRuntime?.currentBranch).toBe(
      "ABC-123_Fix-Broken-Model-Relationships_Author_Name",
    );
    expect(path.basename(result.workspace?.workspaceDirectory ?? "")).toBe("git-valid-branch-name");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 180000);

test("workspace.create always creates a new worktree when the slug is already occupied", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const first = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        worktreeSlug: "same-slug",
        baseBranch: "main",
      },
    });
    const second = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        worktreeSlug: "same-slug",
        baseBranch: "main",
      },
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(path.basename(first.workspace?.workspaceDirectory ?? "")).toBe("same-slug");
    expect(path.basename(second.workspace?.workspaceDirectory ?? "")).toBe("same-slug-1");
    expect(second.workspace?.id).not.toBe(first.workspace?.id);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 180000);

test("workspace.create suffixes past an occupied detached worktree", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const first = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        worktreeSlug: "detached-slug",
        baseBranch: "main",
      },
    });
    expect(first.error).toBeNull();
    expect(first.workspace?.workspaceDirectory).toBeTypeOf("string");
    const firstPath = first.workspace?.workspaceDirectory as string;
    execFileSync("git", ["checkout", "--detach"], { cwd: firstPath, stdio: "pipe" });

    const second = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        worktreeSlug: "detached-slug",
        baseBranch: "main",
      },
    });

    expect(second.error).toBeNull();
    expect(path.basename(second.workspace?.workspaceDirectory ?? "")).toBe("detached-slug-1");
    expect(second.workspace?.gitRuntime?.currentBranch).toBe("detached-slug-1");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 180000);

test("workspace.create suffixes an occupied checkout branch", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const first = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "checkout",
        refName: "feature/existing-branch",
        worktreeSlug: "existing-branch",
      },
    });
    const second = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "checkout",
        refName: "feature/existing-branch",
        worktreeSlug: "existing-branch",
      },
    });

    expect(first.error).toBeNull();
    expect(first.workspace?.gitRuntime?.currentBranch).toBe("feature/existing-branch");
    expect(second.error).toBeNull();
    expect(path.basename(second.workspace?.workspaceDirectory ?? "")).toBe("existing-branch-1");
    expect(second.workspace?.gitRuntime?.currentBranch).toBe("feature/existing-branch-1");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 180000);

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}
function commitFile(cwd: string, name: string, content: string): void {
  writeFileSync(path.join(cwd, name), content);
  runGit(cwd, "add", name);
  runGit(cwd, "-c", "commit.gpgsign=false", "commit", "-m", name);
}

test.each([
  ["refs/heads/main", "refs/remotes/origin/main"],
  ["refs/remotes/origin/main", "refs/heads/main"],
])(
  "restore preserves %s through comparison, update and local merge",
  async (baseRef, conflictingRef) => {
    const workspace = await createRestorableWorkspace(baseRef);
    await archiveAndRestoreWorkspace(workspace);
    await expectRestoredComparison(workspace, conflictingRef);
    await updateFromOriginalBase(workspace);
    await expectMergeIntoLocalBase(workspace);
  },
  180000,
);

test("restore preserves upstream comparison and update but rejects a missing local merge target", async () => {
  const workspace = await createRestorableWorkspace("refs/remotes/upstream/main");
  await archiveAndRestoreWorkspace(workspace);
  await expectRestoredComparison(workspace, "refs/heads/main");
  await updateFromOriginalBase(workspace);
  await expectMissingLocalMergeTarget(workspace);
}, 180000);

async function createRestorableWorkspace(baseRef: string) {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  onTestFinished(async () => {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  createDivergentBases(repoDir);
  await client.connect();
  const created = await client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: repoDir,
      action: "branch-off",
      baseBranch: baseRef,
      branchName: "feature/restore",
      worktreeSlug: "restore-base",
    },
  });
  expect(created.error).toBeNull();
  const workspace = created.workspace!;
  const cwd = workspace.workspaceDirectory;
  commitFile(cwd, "feature.txt", "feature change\n");
  const head = runGit(cwd, "rev-parse", "HEAD");
  await client.checkoutRefresh(cwd);
  const before = await client.getCheckoutDiff(cwd, { mode: "base", baseRef: "main" });
  expect(before.error).toBeNull();
  expect(before.files.map((file) => file.path)).toEqual(["feature.txt"]);
  expect((await client.getCheckoutStatus(cwd)).baseRef).toBe("main");
  return { client, daemon, repoDir, workspace, cwd, head, before, baseRef };
}

type RestorableWorkspace = Awaited<ReturnType<typeof createRestorableWorkspace>>;

function createDivergentBases(repoDir: string): void {
  const root = runGit(repoDir, "rev-parse", "HEAD");
  // Same displayed name, three different commit streams.
  commitFile(repoDir, "local.txt", "local base\n");
  runGit(repoDir, "switch", "--detach", root);
  commitFile(repoDir, "origin.txt", "origin base\n");
  runGit(repoDir, "update-ref", "refs/remotes/origin/main", "HEAD");
  runGit(repoDir, "switch", "--detach", root);
  commitFile(repoDir, "upstream.txt", "upstream base\n");
  runGit(repoDir, "update-ref", "refs/remotes/upstream/main", "HEAD");
  runGit(repoDir, "switch", "main");
}

async function archiveAndRestoreWorkspace({ client, workspace, cwd }: RestorableWorkspace) {
  expect((await client.archiveWorkspace(workspace.id)).error).toBeNull();
  expect(existsSync(cwd)).toBe(false);
  expect(await client.inspectWorkspaceRecovery(workspace.id)).toMatchObject({ action: "restore" });
  await client.restoreWorkspace(workspace.id);
}

async function expectRestoredComparison(
  { client, daemon, workspace, cwd, head, before, baseRef }: RestorableWorkspace,
  conflictingRef: string,
) {
  const restoredStatus = await client.getCheckoutStatus(cwd);
  await client.checkoutRefresh(cwd);
  const after = await client.getCheckoutDiff(cwd, {
    mode: "base",
    baseRef: restoredStatus.baseRef ?? undefined,
  });
  expect(after.error).toBeNull();
  expect(after.files).toEqual(before.files);
  expect(runGit(cwd, "rev-parse", "HEAD")).toBe(head);
  expect(runGit(cwd, "branch", "--show-current")).toBe("feature/restore");
  expect(await client.getCheckoutStatus(cwd)).toMatchObject({
    baseRef: "main",
    aheadBehind: { ahead: 1, behind: 0 },
  });
  const history = await client.listCheckoutCommits(cwd);
  expect(history.baseRef).toBe(baseRef);
  expect(history.commits.filter((commit) => !commit.isOnBase).map((commit) => commit.sha)).toEqual([
    head,
  ]);
  expect((await client.getCommitFileDiff(cwd, head, "feature.txt")).file?.path).toBe("feature.txt");
  const records = JSON.parse(
    readFileSync(path.join(daemon.paseoHome, "projects/workspaces.json"), "utf8"),
  );
  expect(
    records.find((record: { workspaceId: string }) => record.workspaceId === workspace.id)
      .baseBranch,
  ).toBe(baseRef);
  expect(
    (await client.getCheckoutDiff(cwd, { mode: "base", baseRef: conflictingRef })).error?.message,
  ).toContain("Base ref mismatch");
}

async function updateFromOriginalBase({ client, repoDir, cwd, baseRef }: RestorableWorkspace) {
  // Advance only the chosen base; Update must not merge a same-named alternative.
  runGit(repoDir, "switch", "--detach", baseRef);
  commitFile(repoDir, "base-update.txt", `${baseRef}\n`);
  const baseUpdate = runGit(repoDir, "rev-parse", "HEAD");
  runGit(repoDir, "update-ref", baseRef, baseUpdate);
  runGit(repoDir, "switch", "main");
  await client.checkoutRefresh(cwd);
  expect(await client.getCheckoutStatus(cwd)).toMatchObject({
    aheadBehind: { ahead: 1, behind: 1 },
  });
  expect((await client.checkoutMergeFromBase(cwd, { baseRef: "main" })).error).toBeNull();
  expect(readFileSync(path.join(cwd, "base-update.txt"), "utf8")).toBe(`${baseRef}\n`);
  expect(runGit(cwd, "merge-base", baseUpdate, "HEAD")).toBe(baseUpdate);
  expect(
    (await client.getCheckoutDiff(cwd, { mode: "base", baseRef: "main" })).files.map(
      (file) => file.path,
    ),
  ).toEqual(["feature.txt"]);
}

async function expectMergeIntoLocalBase({ client, cwd, repoDir }: RestorableWorkspace) {
  expect(
    (
      await client.checkoutMerge(cwd, {
        baseRef: "main",
        strategy: "merge",
        requireCleanTarget: true,
      })
    ).error,
  ).toBeNull();
  expect(runGit(repoDir, "show", "main:feature.txt")).toBe("feature change");
}

async function expectMissingLocalMergeTarget({ client, cwd }: RestorableWorkspace) {
  expect(
    (
      await client.checkoutMerge(cwd, {
        baseRef: "main",
        strategy: "merge",
        requireCleanTarget: true,
      })
    ).error?.message,
  ).toContain("No local merge target is recorded");
}

// Setup output is opt-in even for multiple sockets sharing one logical client.
test("setup details follow one workspace/source and restore after reconnect with minimal directory status", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: true });
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const clients: SocketDaemonClient[] = [];
  const sockets = new Map<string, WebSocket[]>();
  const observations: Array<{ release(): Promise<void> }> = [];
  const workspaces: Array<{ id: string; workspaceDirectory?: string }> = [];
  const mcp = new Client({ name: "setup-test", version: "1.0.0" });
  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`)),
    );
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({ worktree: { setup: "node setup.cjs" } }),
    );
    writeFileSync(
      path.join(repoDir, "setup.cjs"),
      `
const fs = require('node:fs');
console.log('setup started');
fs.writeFileSync('started.txt', 'ready');
let wave = 0;
const timer = setInterval(() => {
  if (fs.existsSync('wave-' + wave)) {
    console.log('wave-' + wave + ':' + 'setup output '.repeat(1000));
    fs.writeFileSync('emitted-' + wave, 'ready');
    wave++;
  }
  if (fs.existsSync('finish.txt')) { clearInterval(timer); process.exit(1); }
}, 20);
`,
    );
    writeFileSync(path.join(repoDir, ".gitignore"), "*.txt\nwave-*\nemitted-*\n");
    execFileSync("git", ["add", "paseo.json", "setup.cjs", ".gitignore"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "setup fixture"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const connect = async (clientId: string) => {
      const client = new SocketDaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        clientId,
        reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
        webSocketFactory: (url) => {
          const socket = new WebSocket(url);
          sockets.set(clientId, [...(sockets.get(clientId) ?? []), socket]);
          return socket as unknown as WebSocketLike;
        },
      });
      clients.push(client);
      await client.connect();
      return client;
    };
    const creator = await connect("setup-creator");
    const viewer = await connect("setup-viewer");
    const sibling = await connect("setup-viewer");
    const quiet = await connect("setup-quiet");
    const viewerMessages: import("@getpaseo/protocol/messages").SessionOutboundMessage[] = [];
    const quietMessages: import("@getpaseo/protocol/messages").SessionOutboundMessage[] = [];
    const siblingMessages: import("@getpaseo/protocol/messages").SessionOutboundMessage[] = [];
    viewer.subscribeRawMessages((message) => viewerMessages.push(message));
    quiet.subscribeRawMessages((message) => quietMessages.push(message));
    sibling.subscribeRawMessages((message) => siblingMessages.push(message));
    const directory = quiet.observeWorkspaces();
    observations.push(directory);
    await directory.ready;
    for (const worktreeSlug of ["noisy-a", "noisy-b", "noisy-c"]) {
      const result = await creator.createWorkspace({
        source: { kind: "worktree", cwd: repoDir, worktreeSlug },
      });
      if (!result.workspace || result.error) throw new Error(result.error ?? "No workspace");
      workspaces.push(result.workspace);
      await expect
        .poll(() => existsSync(path.join(result.workspace!.workspaceDirectory!, "started.txt")))
        .toBe(true);
    }
    const external = await mcp.callTool({
      name: "create_workspace",
      arguments: { isolation: "worktree", path: repoDir, worktreeSlug: "noisy-mcp" },
    });
    if (typeof external.structuredContent?.workspaceId !== "string")
      throw new Error("Missing MCP workspace");
    const externalWorkspace = (await creator.fetchWorkspaces()).entries.find(
      (entry) => entry.id === external.structuredContent!.workspaceId,
    );
    if (!externalWorkspace) throw new Error("Missing MCP directory entry");
    workspaces.unshift(externalWorkspace);
    await expect
      .poll(() => existsSync(path.join(externalWorkspace.workspaceDirectory!, "started.txt")))
      .toBe(true);
    const workspace = workspaces[0]!;
    // The child writes its marker before the terminal's output is delivered.
    // Wait for the daemon snapshot, rather than treating the file as an output barrier.
    await expect
      .poll(async () => (await viewer.fetchWorkspaceSetupStatus(workspace.id)).snapshot, {
        timeout: 30000,
      })
      .toMatchObject({ detail: { log: expect.stringContaining("setup started") } });
    const details = viewer.observeWorkspaceSetup(workspace.id);
    observations.push(details);
    const initial = await details.ready;
    expect(initial.snapshot).toMatchObject({
      status: "running",
      detail: { log: expect.stringContaining("setup started") },
    });
    await expect
      .poll(
        () =>
          new Set(
            quietMessages
              .filter(
                (message) =>
                  message.type === "workspace_update" &&
                  message.payload.kind === "upsert" &&
                  message.payload.workspace.setupStatus === "running",
              )
              .map((message) =>
                message.type === "workspace_update" && message.payload.kind === "upsert"
                  ? message.payload.workspace.id
                  : "",
              ),
          ).size,
      )
      .toBe(4);
    for (const entry of workspaces) {
      writeFileSync(path.join(entry.workspaceDirectory!, "wave-0"), "go");
      await expect
        .poll(() => existsSync(path.join(entry.workspaceDirectory!, "emitted-0")))
        .toBe(true);
    }
    await expect
      .poll(
        () =>
          viewerMessages.filter(
            (message) =>
              message.type === "workspace_setup_progress" &&
              message.payload.detail.log.includes("wave-0:"),
          ).length,
      )
      .toBeGreaterThan(0);
    expect(
      viewerMessages
        .filter((message) => message.type === "workspace_setup_progress")
        .map((message) => message.payload.workspaceId),
    ).toEqual(expect.arrayContaining([workspace.id]));
    expect(
      new Set(
        viewerMessages
          .filter((message) => message.type === "workspace_setup_progress")
          .map((message) => message.payload.workspaceId),
      ),
    ).toEqual(new Set([workspace.id]));
    expect(quietMessages.filter((message) => message.type === "workspace_setup_progress")).toEqual(
      [],
    );
    expect(
      siblingMessages.filter((message) => message.type === "workspace_setup_progress"),
    ).toEqual([]);
    for (const message of quietMessages) {
      if (message.type !== "workspace_update" || message.payload.kind !== "upsert") continue;
      expect(message.payload.workspace).not.toHaveProperty("detail");
      expect(message.payload.workspace).not.toHaveProperty("error");
    }
    const waveLogs = viewerMessages
      .filter(
        (message) =>
          message.type === "workspace_setup_progress" &&
          message.payload.detail.log.includes("wave-0:"),
      )
      .map((message) =>
        message.type === "workspace_setup_progress" ? message.payload.detail.log : "",
      );
    expect(waveLogs.length).toBe(new Set(waveLogs).size);
    const restoredSnapshots: unknown[] = [];
    details.subscribe({
      snapshot: (snapshot) => restoredSnapshots.push(snapshot),
      update: () => {},
    });
    const beforeReconnect = details.subscriptionId;
    sockets.get("setup-viewer")![0]!.terminate();
    await expect.poll(() => restoredSnapshots.length, { timeout: 10000 }).toBe(2);
    expect(details.subscriptionId).not.toBe(beforeReconnect);
    expect(restoredSnapshots[1]).toMatchObject({
      snapshot: { detail: { log: expect.stringContaining("wave-0:") } },
    });
    const subscriptionId = details.subscriptionId;
    await details.release();
    viewerMessages.length = 0;
    writeFileSync(path.join(workspace.workspaceDirectory!, "wave-1"), "go");
    await expect
      .poll(() => existsSync(path.join(workspace.workspaceDirectory!, "emitted-1")))
      .toBe(true);
    // Wait until the daemon has consumed the output before checking wire silence.
    await expect
      .poll(
        async () => (await viewer.fetchWorkspaceSetupStatus(workspace.id)).snapshot?.detail.log,
        {
          timeout: 30000,
        },
      )
      .toContain("wave-1:");
    expect(viewerMessages.filter((message) => message.type === "workspace_setup_progress")).toEqual(
      [],
    );
    const resumed = viewer.observeWorkspaceSetup(workspace.id);
    observations.push(resumed);
    expect((await resumed.ready).snapshot?.detail.log).toContain("wave-1:");
    expect(resumed.subscriptionId).not.toBe(subscriptionId);
    writeFileSync(path.join(workspaces[1]!.workspaceDirectory!, "finish.txt"), "fail");
    await expect
      .poll(
        () =>
          quietMessages.filter(
            (message) =>
              message.type === "workspace_update" &&
              message.payload.kind === "upsert" &&
              message.payload.workspace.id === workspaces[1]!.id &&
              message.payload.workspace.setupStatus === "failed",
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    expect(quietMessages.filter((message) => message.type === "workspace_setup_progress")).toEqual(
      [],
    );
    await resumed.release();
    await directory.release();
  } finally {
    // End every fixture command and release observations while transports are live,
    // including when an assertion fails before the normal release path.
    for (const workspace of workspaces) {
      writeFileSync(path.join(workspace.workspaceDirectory!, "finish.txt"), "stop");
    }
    for (const observation of observations) await observation.release();
    await mcp.close();
    for (const client of clients) await client.close();
    await daemon.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 180000);
