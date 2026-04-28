import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../workspace-registry.js";

const cleanupPaths = new Set<string>();
const cleanupDaemons = new Set<TestPaseoDaemon>();
const cleanupClients = new Set<DaemonClient>();

afterEach(async () => {
  await Promise.all(Array.from(cleanupClients, (client) => client.close().catch(() => undefined)));
  cleanupClients.clear();
  await Promise.all(Array.from(cleanupDaemons, (daemon) => daemon.close().catch(() => undefined)));
  cleanupDaemons.clear();
  await Promise.all(
    Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })),
  );
  cleanupPaths.clear();
});

test("openProject reclassifies an existing directory workspace into its parent git project", async () => {
  const previousSupervised = process.env.PASEO_SUPERVISED;
  process.env.PASEO_SUPERVISED = "0";
  try {
    const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-open-project-repo-")));
    const worktreeRoot = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "paseo-open-project-worktree-")),
    );
    const paseoHomeRoot = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "paseo-open-project-home-")),
    );
    cleanupPaths.add(repoRoot);
    cleanupPaths.add(worktreeRoot);
    cleanupPaths.add(paseoHomeRoot);

    execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
    execSync("git config user.email 'test@getpaseo.dev'", { cwd: repoRoot, stdio: "pipe" });
    execSync("git config user.name 'Paseo Test'", { cwd: repoRoot, stdio: "pipe" });
    writeFileSync(path.join(repoRoot, "README.md"), "# repo\n", "utf8");
    execSync("git add README.md", { cwd: repoRoot, stdio: "pipe" });
    execSync("git -c commit.gpgSign=false commit -m 'initial'", { cwd: repoRoot, stdio: "pipe" });
    execSync("git branch feature/desktop-daemon-settings", { cwd: repoRoot, stdio: "pipe" });
    execSync(`git worktree add ${JSON.stringify(worktreeRoot)} feature/desktop-daemon-settings`, {
      cwd: repoRoot,
      stdio: "pipe",
    });

    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const projectsPath = path.join(paseoHome, "projects", "projects.json");
    const workspacesPath = path.join(paseoHome, "projects", "workspaces.json");
    const timestamp = "2026-04-24T09:46:43.146Z";

    await mkdir(path.dirname(projectsPath), { recursive: true });
    await writeRegistry(projectsPath, [
      createPersistedProjectRecord({
        projectId: repoRoot,
        rootPath: repoRoot,
        kind: "git",
        displayName: "repo",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      createPersistedProjectRecord({
        projectId: worktreeRoot,
        rootPath: worktreeRoot,
        kind: "non_git",
        displayName: "desktop-daemon-settings",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ]);
    await writeRegistry(workspacesPath, [
      createPersistedWorkspaceRecord({
        workspaceId: repoRoot,
        projectId: repoRoot,
        cwd: repoRoot,
        kind: "local_checkout",
        displayName: "main",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      createPersistedWorkspaceRecord({
        workspaceId: worktreeRoot,
        projectId: worktreeRoot,
        cwd: worktreeRoot,
        kind: "directory",
        displayName: "desktop-daemon-settings",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ]);

    const daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    cleanupDaemons.add(daemon);
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    cleanupClients.add(client);
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "worktree-reclassification" } });

    const response = await client.openProject(worktreeRoot);
    const persistedProjects = await readRegistry<PersistedProjectRecord>(projectsPath);
    const persistedWorkspaces = await readRegistry<PersistedWorkspaceRecord>(workspacesPath);

    expect(response.error).toBeNull();
    expect(response.workspace?.projectId).toBe(repoRoot);
    expect(response.workspace?.workspaceKind).toBe("worktree");
    expect(persistedProjects.find((project) => project.projectId === repoRoot)?.rootPath).toBe(
      repoRoot,
    );
    expect(
      persistedWorkspaces.find((workspace) => workspace.workspaceId === worktreeRoot)?.projectId,
    ).toBe(repoRoot);
    expect(
      persistedWorkspaces.find((workspace) => workspace.workspaceId === worktreeRoot)?.kind,
    ).toBe("worktree");
  } finally {
    process.env.PASEO_SUPERVISED = previousSupervised;
  }
}, 30_000);

async function writeRegistry(
  filePath: string,
  records: PersistedProjectRecord[] | PersistedWorkspaceRecord[],
): Promise<void> {
  await writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
}

async function readRegistry<TRecord>(filePath: string): Promise<TRecord[]> {
  return JSON.parse(await readFile(filePath, "utf8")) as TRecord[];
}
