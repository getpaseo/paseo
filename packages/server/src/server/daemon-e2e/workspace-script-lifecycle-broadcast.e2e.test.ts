import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import type { DaemonEvent } from "@getpaseo/client";
import type { WorkspaceScriptPayload } from "../messages.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const SCRIPT_NAME = "sleeper";
const OBSERVE_TIMEOUT_MS = 15_000;

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

async function connectClient(daemon: TestPaseoDaemon): Promise<DaemonClient> {
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  return client;
}

function recordScriptLifecycles(client: DaemonClient) {
  const lifecycles: Array<WorkspaceScriptPayload["lifecycle"]> = [];
  const listeners = new Set<() => void>();
  client.subscribe((event: DaemonEvent) => {
    if (event.type !== "workspace_update" || event.payload.kind !== "upsert") return;
    const script = event.payload.workspace.scripts.find(
      (entry) => entry.scriptName === SCRIPT_NAME,
    );
    if (!script) return;
    lifecycles.push(script.lifecycle);
    for (const listener of listeners) listener();
  });
  function waitFor(
    lifecycle: WorkspaceScriptPayload["lifecycle"],
    fromIndex: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (lifecycles.slice(fromIndex).includes(lifecycle)) settle();
      };
      const timer = setTimeout(
        () =>
          settle(
            new Error(
              `Timed out waiting for "${lifecycle}" workspace_update; saw [${lifecycles.slice(fromIndex).join(", ")}]`,
            ),
          ),
        OBSERVE_TIMEOUT_MS,
      );
      listeners.add(check);
      check();
    });
  }
  return { lifecycles, waitFor };
}

test("workspace script lifecycle reaches other subscribed clients and only them", async () => {
  const workspaceRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-script-bcast-")));
  cleanupPaths.add(workspaceRoot);
  writeFileSync(
    path.join(workspaceRoot, "paseo.json"),
    JSON.stringify({
      scripts: {
        [SCRIPT_NAME]: { type: "script", command: 'node -e "setInterval(() => {}, 1000)"' },
      },
    }),
    "utf8",
  );

  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);
  const requester = await connectClient(daemon);
  const observer = await connectClient(daemon);
  const unsubscribed = await connectClient(daemon);
  await requester.fetchWorkspaces({ subscribe: {} });
  await observer.fetchWorkspaces({ subscribe: {} });

  const observed = recordScriptLifecycles(observer);
  const bystander: string[] = [];
  unsubscribed.subscribe((event: DaemonEvent) => {
    if (event.type === "workspace_update") bystander.push(event.workspaceId);
  });

  const opened = await requester.openProject(workspaceRoot);
  expect(opened.error).toBeNull();
  const workspaceId = opened.workspace!.id;

  // Exclude the initial stopped state from the lifecycle assertions.
  await observed.waitFor("stopped", 0);
  const afterCreate = observed.lifecycles.length;

  const started = await requester.startWorkspaceScriptWithStatus(workspaceId, SCRIPT_NAME);
  expect(started.error).toBeNull();
  expect(started.script?.lifecycle).toBe("running");
  await observed.waitFor("running", afterCreate);

  const stopped = await requester.stopWorkspaceScript(workspaceId, SCRIPT_NAME);
  expect(stopped.error).toBeNull();
  expect(stopped.script?.lifecycle).toBe("stopped");
  await observed.waitFor("stopped", afterCreate + 1);

  expect(observed.lifecycles.slice(afterCreate)).toEqual(["running", "stopped"]);

  await unsubscribed.listWorkspaceScripts(workspaceId);
  expect(bystander).toEqual([]);
}, 60_000);

test("a workspace script exiting on its own reaches other subscribed clients", async () => {
  const workspaceRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-script-exit-")));
  cleanupPaths.add(workspaceRoot);
  writeFileSync(
    path.join(workspaceRoot, "paseo.json"),
    JSON.stringify({
      scripts: { [SCRIPT_NAME]: { type: "script", command: 'node -e "process.exit(0)"' } },
    }),
    "utf8",
  );

  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);
  const requester = await connectClient(daemon);
  const observer = await connectClient(daemon);
  await observer.fetchWorkspaces({ subscribe: {} });
  const observed = recordScriptLifecycles(observer);

  const opened = await requester.openProject(workspaceRoot);
  expect(opened.error).toBeNull();
  await observed.waitFor("stopped", 0);
  const afterCreate = observed.lifecycles.length;

  const started = await requester.startWorkspaceScriptWithStatus(opened.workspace!.id, SCRIPT_NAME);
  expect(started.error).toBeNull();
  await observed.waitFor("running", afterCreate);
  await observed.waitFor("stopped", afterCreate + 1);
  expect(observed.lifecycles.slice(afterCreate)).toEqual(["running", "stopped"]);
  const result = await requester.listWorkspaceScripts(opened.workspace!.id);
  expect(result.error).toBeNull();
  expect(result.scripts).toEqual([
    expect.objectContaining({ scriptName: SCRIPT_NAME, lifecycle: "stopped", exitCode: 0 }),
  ]);
}, 60_000);
