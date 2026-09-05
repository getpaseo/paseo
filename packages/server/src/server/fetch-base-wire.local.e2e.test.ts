import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const CREATED_AT = "2026-08-07T00:00:00.000Z";

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
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function commit(cwd: string, content: string): string {
  writeFileSync(join(cwd, "file.txt"), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", content);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * A local clone that has fallen behind its origin, plus a daemon observing it.
 * This is the state the user hits after someone else pushes while they were away.
 */
async function startStaleCheckoutFixture(): Promise<{
  localDir: string;
  projectId: string;
  staleHead: string;
  freshHead: string;
}> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "paseo-fetch-base-wire-"));
  cleanupPaths.push(fixtureRoot);
  const originDir = join(fixtureRoot, "origin.git");
  git(fixtureRoot, "init", "-q", "--bare", "-b", "main", originDir);

  const seedDir = join(fixtureRoot, "seed");
  git(fixtureRoot, "clone", "-q", originDir, seedDir);
  git(seedDir, "config", "user.email", "test@test.com");
  git(seedDir, "config", "user.name", "Test");
  const staleHead = commit(seedDir, "one");
  git(seedDir, "push", "-q", "origin", "main");

  const localDir = join(fixtureRoot, "local");
  git(fixtureRoot, "clone", "-q", originDir, localDir);
  git(localDir, "config", "user.email", "test@test.com");
  git(localDir, "config", "user.name", "Test");

  const freshHead = commit(seedDir, "two");
  git(seedDir, "push", "-q", "origin", "main");

  const paseoHomeRoot = join(fixtureRoot, "home");
  const projectsDir = join(paseoHomeRoot, ".paseo", "projects");
  mkdirSync(projectsDir, { recursive: true });
  const projectId = "prj_0000000000000001";
  writeFileSync(
    join(projectsDir, "projects.json"),
    JSON.stringify([
      {
        projectId,
        rootPath: localDir,
        kind: "git",
        displayName: "local",
        projectKey: null,
        customName: null,
        customIconRevision: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
      },
    ]),
  );
  writeFileSync(join(projectsDir, "workspaces.json"), JSON.stringify([]));

  daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false, mcpEnabled: false });
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.0" });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "agents" } });
  await client.fetchWorkspaces({
    page: { limit: 200 },
    subscribe: { subscriptionId: "workspaces" },
  });

  return { localDir, projectId, staleHead, freshHead };
}

test("advertises workspaceCreateFetchBase so clients can show the control", async () => {
  await startStaleCheckoutFixture();

  expect(client?.getLastServerInfoMessage()?.features?.workspaceCreateFetchBase).toBe(true);
}, 120_000);

test("branches a new workspace off the freshest origin commit by default", async () => {
  const fixture = await startStaleCheckoutFixture();

  expect(git(fixture.localDir, "rev-parse", "refs/remotes/origin/main")).toBe(fixture.staleHead);

  const created = await client?.createWorkspace({
    source: {
      kind: "worktree",
      cwd: fixture.localDir,
      projectId: fixture.projectId,
      action: "branch-off",
      refName: "main",
      branchName: "wire-default",
      worktreeSlug: "wire-default",
    },
  });

  expect(created?.error).toBeNull();
  const cwd = created?.workspace?.workspaceDirectory;
  expect(cwd).toBeTruthy();
  expect(git(cwd as string, "rev-parse", "HEAD")).toBe(fixture.freshHead);
  // The user's own checkout is never moved.
  expect(git(fixture.localDir, "rev-parse", "refs/heads/main")).toBe(fixture.staleHead);
}, 120_000);

test("honours an explicit opt-out sent over the wire", async () => {
  const fixture = await startStaleCheckoutFixture();

  const created = await client?.createWorkspace({
    source: {
      kind: "worktree",
      cwd: fixture.localDir,
      projectId: fixture.projectId,
      action: "branch-off",
      refName: "main",
      branchName: "wire-opted-out",
      worktreeSlug: "wire-opted-out",
      fetchBase: false,
    },
  });

  expect(created?.error).toBeNull();
  const cwd = created?.workspace?.workspaceDirectory;
  expect(cwd).toBeTruthy();
  expect(git(cwd as string, "rev-parse", "HEAD")).toBe(fixture.staleHead);
  expect(git(fixture.localDir, "rev-parse", "refs/remotes/origin/main")).toBe(fixture.staleHead);
}, 120_000);
