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

// Unit 2.2: a project persists as a first-class empty project after its last
// workspace is archived, and is exposed to clients via fetch_workspaces.
test("archiving the last workspace leaves the project as an empty project parent", async () => {
  const previousSupervised = process.env.PASEO_SUPERVISED;
  process.env.PASEO_SUPERVISED = "0";
  try {
    const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-empty-project-repo-")));
    const paseoHomeRoot = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "paseo-empty-project-home-")),
    );
    cleanupPaths.add(repoRoot);
    cleanupPaths.add(paseoHomeRoot);

    execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
    execSync("git config user.email 'test@getpaseo.dev'", { cwd: repoRoot, stdio: "pipe" });
    execSync("git config user.name 'Paseo Test'", { cwd: repoRoot, stdio: "pipe" });
    writeFileSync(path.join(repoRoot, "README.md"), "# repo\n", "utf8");
    execSync("git add README.md", { cwd: repoRoot, stdio: "pipe" });
    execSync("git -c commit.gpgSign=false commit -m 'initial'", { cwd: repoRoot, stdio: "pipe" });

    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const projectsPath = path.join(paseoHome, "projects", "projects.json");
    const workspacesPath = path.join(paseoHome, "projects", "workspaces.json");
    const timestamp = "2026-04-24T09:46:43.146Z";

    await mkdir(path.dirname(projectsPath), { recursive: true });
    await writeFile(
      projectsPath,
      JSON.stringify(
        [
          createPersistedProjectRecord({
            projectId: repoRoot,
            rootPath: repoRoot,
            kind: "git",
            displayName: "repo",
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      workspacesPath,
      JSON.stringify(
        [
          createPersistedWorkspaceRecord({
            workspaceId: repoRoot,
            projectId: repoRoot,
            cwd: repoRoot,
            kind: "local_checkout",
            displayName: "main",
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        null,
        2,
      ),
      "utf8",
    );

    const daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    cleanupDaemons.add(daemon);
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    cleanupClients.add(client);
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "empty-project-agents" } });

    const beforeArchive = await client.fetchWorkspaces();
    expect(beforeArchive.entries.map((entry) => entry.id)).toContain(repoRoot);
    expect(beforeArchive.emptyProjects.map((project) => project.projectId)).not.toContain(repoRoot);

    await client.archiveWorkspace(repoRoot);

    const afterArchive = await client.fetchWorkspaces();
    expect(afterArchive.entries.map((entry) => entry.id)).not.toContain(repoRoot);
    expect(afterArchive.emptyProjects.map((project) => project.projectId)).toContain(repoRoot);

    const persistedProjects = JSON.parse(
      await readFile(projectsPath, "utf8"),
    ) as PersistedProjectRecord[];
    expect(
      persistedProjects.find((project) => project.projectId === repoRoot)?.archivedAt,
    ).toBeNull();
  } finally {
    process.env.PASEO_SUPERVISED = previousSupervised;
  }
}, 30_000);
