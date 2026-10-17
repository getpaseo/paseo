import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      if (content.endsWith("\n")) return content.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function createRepoWithSetup(): string {
  const repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "terminal-restore-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  writeFileSync(
    path.join(repoRoot, "paseo.json"),
    JSON.stringify({ worktree: { setup: ['echo done > "$PASEO_WORKTREE_PATH/setup-done"'] } }),
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
  return repoRoot;
}

async function startDaemon(paseoHomeRoot: string): Promise<{
  daemon: TestPaseoDaemon;
  client: DaemonClient;
}> {
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    restoreTerminals: true,
    cleanup: false,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  return { daemon, client };
}

test("a terminal tab survives a daemon restart with the same id", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-terminal-restore-"));
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "terminal-restore-cwd-")));
  cleanups.push(async () => {
    await rm(paseoHomeRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const first = await startDaemon(paseoHomeRoot);
  const opened = await first.client.openProject(cwd);
  const workspaceId = opened.workspace?.id;
  expect(workspaceId).toBeTruthy();
  const created = await first.client.createTerminal(cwd, "Restored tab", undefined, {
    workspaceId,
  });
  const terminalId = created.terminal?.id;
  expect(terminalId).toBeTruthy();
  await first.client.close();
  await first.daemon.close();

  const second = await startDaemon(paseoHomeRoot);
  cleanups.push(async () => {
    await second.client.close();
    await second.daemon.close();
  });
  const listed = await second.client.listTerminals(cwd, undefined, { workspaceId });

  expect(listed.terminals).toEqual([
    expect.objectContaining({ id: terminalId, name: "Restored tab", workspaceId }),
  ]);
});

test("a restored worktree terminal gets the worktree env back", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-terminal-restore-"));
  const repoRoot = createRepoWithSetup();
  cleanups.push(async () => {
    await rm(paseoHomeRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });
  const printEnv =
    'printf "%s|%s\\n" "$PASEO_WORKTREE_PATH" "$PASEO_WORKTREE_PORT" > "$PASEO_WORKTREE_PATH/../env-$MARKER.txt"';

  const first = await startDaemon(paseoHomeRoot);
  await first.client.openProject(repoRoot);
  const created = await first.client.createPaseoWorktree({
    cwd: repoRoot,
    worktreeSlug: "restore-env",
  });
  const workspace = created.workspace;
  if (!workspace) throw new Error(created.error ?? "Expected a worktree workspace");
  const worktreePath = workspace.workspaceDirectory ?? workspace.projectRootPath;
  await waitForFile(path.join(worktreePath, "setup-done"));
  const terminal = await first.client.createTerminal(worktreePath, "Worktree tab", undefined, {
    workspaceId: workspace.id,
  });
  const terminalId = terminal.terminal?.id;
  if (!terminalId) throw new Error(terminal.error ?? "Expected a terminal");
  first.client.sendTerminalInput(terminalId, {
    type: "input",
    data: `MARKER=before; ${printEnv}\r`,
  });
  const before = await waitForFile(path.join(worktreePath, "..", "env-before.txt"));
  await first.client.close();
  await first.daemon.close();

  const second = await startDaemon(paseoHomeRoot);
  cleanups.push(async () => {
    await second.client.close();
    await second.daemon.close();
  });
  await second.client.listTerminals(worktreePath, undefined, { workspaceId: workspace.id });
  second.client.sendTerminalInput(terminalId, {
    type: "input",
    data: `MARKER=after; ${printEnv}\r`,
  });
  const after = await waitForFile(path.join(worktreePath, "..", "env-after.txt"));

  expect(before).toMatch(/\|\d+$/);
  expect(after).toBe(before);
}, 60_000);
