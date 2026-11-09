import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { withTimeout } from "../../utils/promise-timeout.js";
import { DaemonClient, type DaemonEvent } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { type PersistedProjectRecord } from "../workspace-registry.js";

const cleanupPaths = new Set<string>();
const cleanupDaemons = new Set<TestPaseoDaemon>();
const cleanupClients = new Set<DaemonClient>();
const cleanupListeners = new Set<() => void>();
const execFile = promisify(execFileCallback);

type ProjectUpdatePayload = Extract<DaemonEvent, { type: "project.update" }>["payload"];

function waitForProjectUpdate(
  client: DaemonClient,
  predicate: (payload: ProjectUpdatePayload) => boolean,
): Promise<ProjectUpdatePayload> {
  return new Promise((resolve) => {
    const unsubscribe = client.on("project.update", (message) => {
      if (!predicate(message.payload)) return;
      cleanupListeners.delete(unsubscribe);
      unsubscribe();
      resolve(message.payload);
    });
    cleanupListeners.add(unsubscribe);
  });
}

afterEach(async () => {
  for (const unsubscribe of cleanupListeners) unsubscribe();
  cleanupListeners.clear();
  await Promise.all(Array.from(cleanupClients, (client) => client.close().catch(() => undefined)));
  cleanupClients.clear();
  await Promise.all(Array.from(cleanupDaemons, (daemon) => daemon.close().catch(() => undefined)));
  cleanupDaemons.clear();
  await Promise.all(
    Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })),
  );
  cleanupPaths.clear();
});

test("an empty project becomes Git without changing its identity or creating a workspace", async () => {
  const projectRoot = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "paseo-project-becomes-git-")),
  );
  const paseoHomeRoot = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "paseo-project-becomes-git-home-")),
  );
  cleanupPaths.add(projectRoot);
  cleanupPaths.add(paseoHomeRoot);

  const daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
  cleanupDaemons.add(daemon);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const projectEvents = client.observeEvents(["project.update"]);
  await projectEvents.ready;

  const added = await client.addProject(projectRoot);

  expect(added).toMatchObject({
    requestId: expect.any(String),
    project: {
      projectId: expect.stringMatching(/^prj_[0-9a-f]{16}$/),
      projectDisplayName: path.basename(projectRoot),
      projectCustomName: null,
      projectRootPath: projectRoot,
      projectKind: "non_git",
    },
    error: null,
  });
  const {
    projectIconRevision: _icon,
    projectCustomIconRevision: _customIcon,
    ...project
  } = added.project!;
  const beforeGitInit = await client.fetchWorkspaces({ filter: { projectId: project.projectId } });
  expect(beforeGitInit).toMatchObject({ entries: [], emptyProjects: [project] });

  const gitProjectUpdate = waitForProjectUpdate(
    client,
    (payload) =>
      payload.kind === "upsert" &&
      payload.project.projectId === project.projectId &&
      payload.project.projectRootPath === projectRoot &&
      payload.project.projectKind === "git",
  );
  await execFile("git", ["init", "-b", "main"], { cwd: projectRoot });
  const update = await withTimeout({
    promise: gitProjectUpdate,
    timeoutMs: 10_000,
    label: "project.update after git init",
  });

  expect(update).toMatchObject({
    kind: "upsert",
    project: { ...project, projectKind: "git", projectKey: expect.any(String) },
  });

  const afterGitInit = await client.fetchWorkspaces({ filter: { projectId: project.projectId } });
  expect(afterGitInit).toMatchObject({
    entries: [],
    emptyProjects: [{ ...project, projectKind: "git", projectKey: expect.any(String) }],
  });

  const persistedProjects = JSON.parse(
    await readFile(path.join(daemon.paseoHome, "projects", "projects.json"), "utf8"),
  ) as PersistedProjectRecord[];
  expect(persistedProjects).toContainEqual({
    projectId: project.projectId,
    rootPath: projectRoot,
    kind: "git",
    displayName: project.projectDisplayName,
    customName: null,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    archivedAt: null,
    projectKey: expect.any(String),
    customIconRevision: null,
  });
}, 30_000);

test("a failed worktree attempt before git init does not prevent creation afterward", async () => {
  const projectRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-init-worktree-")));
  const paseoHomeRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-init-home-")));
  cleanupPaths.add(projectRoot);
  cleanupPaths.add(paseoHomeRoot);
  await writeFile(path.join(projectRoot, "README.md"), "hi\n");

  const daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
  cleanupDaemons.add(daemon);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const projectEvents = client.observeEvents(["project.update"]);
  await projectEvents.ready;
  const added = await client.addProject(projectRoot);
  expect(added.project?.projectKind).toBe("non_git");
  const source = {
    kind: "worktree" as const,
    cwd: projectRoot,
    projectId: added.project!.projectId,
    action: "branch-off" as const,
    refName: "main",
    branchName: "after-init",
    worktreeSlug: "after-init",
  };
  const before = await client.createWorkspace({ source });
  expect(before.error).toBe("Create worktree requires a git repository");

  const gitProjectUpdate = waitForProjectUpdate(
    client,
    (payload) =>
      payload.kind === "upsert" &&
      payload.project.projectId === added.project!.projectId &&
      payload.project.projectKind === "git",
  );
  await execFile("git", ["init", "-b", "main"], { cwd: projectRoot });
  await execFile("git", ["add", "README.md"], { cwd: projectRoot });
  await execFile(
    "git",
    [
      "-c",
      "user.name=Paseo Test",
      "-c",
      "user.email=test@getpaseo.dev",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: projectRoot },
  );
  await withTimeout({ promise: gitProjectUpdate, timeoutMs: 10_000, label: "project becomes Git" });
  const projects = await client.fetchWorkspaces({
    filter: { projectId: added.project!.projectId },
  });
  expect(projects.emptyProjects[0]?.projectKind).toBe("git");

  const created = await client.createWorkspace({ source });
  expect(created.error).toBeNull();
  expect(created.workspace?.workspaceKind).toBe("worktree");
  expect(created.workspace?.projectId).toBe(added.project!.projectId);
}, 30_000);
