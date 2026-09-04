import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// workspace.create with source.reuseExisting must dedupe on the daemon side:
// the daemon resolves `~`, dot segments, and symlinks against its own
// filesystem, so equivalent spellings of an already-registered directory reuse
// the active workspace instead of minting a duplicate ID.

function createGitRepo(): { repoDir: string; tempRoot: string } {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "workspace-create-reuse-"));
  const repoDir = path.join(tempRoot, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return { repoDir, tempRoot };
}

async function createWorkspace(client: DaemonClient, sourcePath: string, reuseExisting?: boolean) {
  return client.createWorkspace({
    source: {
      kind: "directory",
      path: sourcePath,
      ...(reuseExisting !== undefined ? { reuseExisting } : {}),
    },
  });
}

test("reuseExisting returns the existing workspace for a dot-segment spelling", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepo();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();

    const first = await createWorkspace(client, repoDir, true);
    expect(first.error).toBeNull();

    const aliased = `${path.dirname(repoDir)}/./${path.basename(repoDir)}/`;
    const second = await createWorkspace(client, aliased, true);
    expect(second.error).toBeNull();
    expect(second.workspace?.id).toBe(first.workspace?.id);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 180000);

test("reuseExisting returns the existing workspace registered through a symlink", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepo();
  const linkDir = path.join(tempRoot, "link");
  symlinkSync(repoDir, linkDir);
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();

    // Register through the symlink; request again through the real path.
    const first = await createWorkspace(client, linkDir, true);
    expect(first.error).toBeNull();

    const second = await createWorkspace(client, repoDir, true);
    expect(second.error).toBeNull();
    expect(second.workspace?.id).toBe(first.workspace?.id);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 180000);

test("without reuseExisting the always-fresh contract is preserved", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepo();
  mkdirSync(path.join(tempRoot, "unused"), { recursive: true });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();

    const first = await createWorkspace(client, repoDir);
    expect(first.error).toBeNull();

    const second = await createWorkspace(client, repoDir);
    expect(second.error).toBeNull();
    expect(second.workspace?.id).not.toBe(first.workspace?.id);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 180000);
