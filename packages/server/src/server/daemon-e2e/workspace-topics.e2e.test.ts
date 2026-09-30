import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import type { WorkspaceTopic } from "@getpaseo/protocol/messages";
import { DaemonClient, type DaemonEvent } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

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

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanupPaths.add(dir);
  return dir;
}

async function connect(daemon: TestPaseoDaemon): Promise<DaemonClient> {
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();
  return client;
}

async function topicsById(client: DaemonClient): Promise<Map<string, WorkspaceTopic | null>> {
  const { entries } = await client.fetchWorkspaces();
  return new Map(entries.map((entry) => [entry.id, entry.topic ?? null]));
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for workspace updates");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("two sessions become one topic, a second client sees it live, and it survives a restart", async () => {
  const paseoHomeRoot = tempDir("paseo-topics-home-");
  const daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
  cleanupDaemons.add(daemon);
  const client = await connect(daemon);
  expect(client.getLastServerInfoMessage()?.features?.workspaceTopics).toBe(true);

  const phase1 = (await client.openProject(tempDir("paseo-topics-phase1-"))).workspace;
  const phase2 = (await client.openProject(tempDir("paseo-topics-phase2-"))).workspace;
  if (!phase1 || !phase2) throw new Error("openProject returned no workspace");

  const observer = await connect(daemon);
  const observed = new Map<string, WorkspaceTopic | null>();
  observer.subscribe((event: DaemonEvent) => {
    if (event.type === "workspace_update" && event.payload.kind === "upsert") {
      observed.set(event.payload.workspace.id, event.payload.workspace.topic ?? null);
    }
  });
  await observer.fetchWorkspaces({ subscribe: {} });

  const topic = await client.createWorkspaceTopic({
    title: "Riesling",
    workspaceIds: [phase1.id, phase2.id],
  });
  expect(topic).toMatchObject({
    id: expect.stringMatching(/^top_[0-9a-f]{16}$/),
    title: "Riesling",
  });
  await waitFor(() => observed.get(phase1.id)?.id === topic.id && observed.has(phase2.id));

  const renamed = await client.updateWorkspaceTopic(topic.id, { title: "Riesling launch" });
  await waitFor(
    () =>
      observed.get(phase1.id)?.title === "Riesling launch" &&
      observed.get(phase2.id)?.title === "Riesling launch",
  );

  await client.assignWorkspaceTopic(phase2.id, null);
  await waitFor(() => observed.get(phase2.id) === null);
  await client.assignWorkspaceTopic(phase2.id, topic.id);

  await client.close();
  await observer.close();
  await daemon.close();
  cleanupDaemons.delete(daemon);

  const restarted = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
  cleanupDaemons.add(restarted);
  const after = await topicsById(await connect(restarted));
  expect(after.get(phase1.id)).toEqual(renamed);
  expect(after.get(phase2.id)).toEqual(renamed);
}, 60000);
