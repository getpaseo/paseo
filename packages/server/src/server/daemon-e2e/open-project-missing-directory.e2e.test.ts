import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vitest";

import { DaemonClient, type DaemonEvent } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cleanupPaths = new Set<string>();
const cleanupDaemons = new Set<TestPaseoDaemon>();
const cleanupClients = new Set<DaemonClient>();
let previousSupervised: string | undefined;

beforeEach(() => {
  previousSupervised = process.env.PASEO_SUPERVISED;
  process.env.PASEO_SUPERVISED = "0";
});

afterEach(async () => {
  restoreSupervisedEnv();
  await Promise.all(Array.from(cleanupClients, (client) => client.close().catch(() => undefined)));
  cleanupClients.clear();
  await Promise.all(Array.from(cleanupDaemons, (daemon) => daemon.close().catch(() => undefined)));
  cleanupDaemons.clear();
  await Promise.all(
    Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })),
  );
  cleanupPaths.clear();
});

function restoreSupervisedEnv(): void {
  if (previousSupervised === undefined) {
    delete process.env.PASEO_SUPERVISED;
    return;
  }

  process.env.PASEO_SUPERVISED = previousSupervised;
}

// Repro for the "project flashes in the sidebar then disappears" report.
// The project picker submits the typed query verbatim, so open_project can
// receive a path that does not exist on the daemon's disk. The daemon must not
// answer with a success + workspace upsert that it immediately retracts.
test("openProject on a nonexistent directory does not broadcast an upsert that is immediately removed", async () => {
  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "missing-dir-agents" } });

  const workspaceEvents: Array<{ kind: "upsert" | "remove"; workspaceId: string }> = [];
  client.subscribe((event: DaemonEvent) => {
    if (event.type !== "workspace_update") {
      return;
    }
    workspaceEvents.push({ kind: event.payload.kind, workspaceId: event.workspaceId });
  });
  await client.fetchWorkspaces({ subscribe: { subscriptionId: "missing-dir-workspaces" } });

  const tempParent = await mkdtemp(path.join(os.tmpdir(), "paseo-open-project-"));
  cleanupPaths.add(tempParent);
  const missingPath = path.join(tempParent, "this-directory-does-not-exist");
  const response = await client.openProject(missingPath);

  expect(response.workspace).toBeNull();
  expect(response.error).toBe(`Directory not found: ${missingPath}`);
  expect(response.errorCode).toBe("directory_not_found");
  expect(workspaceEvents).toEqual([]);
}, 30000);

test("openProject expands tilde before creating the workspace", async () => {
  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "tilde-project-agents" } });
  await client.fetchWorkspaces({ subscribe: { subscriptionId: "tilde-project-workspaces" } });

  const home = process.env.HOME || os.homedir();
  const workspacePath = await mkdtemp(path.join(home, ".paseo-open-project-"));
  cleanupPaths.add(workspacePath);
  const queryPath = `~/${path.relative(home, workspacePath)}`;

  const response = await client.openProject(queryPath);

  expect(response.error).toBeNull();
  expect(response.errorCode).toBeUndefined();
  expect(response.workspace?.workspaceDirectory).toBe(workspacePath);
}, 30000);
