import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("reloading an agent whose provider cannot load the session keeps the agent and its history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-acp-failed-load-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const daemon = await createTestPaseoDaemon({
    logger: pino({ level: "silent" }),
    pluginsEnabled: false,
    mcpEnabled: false,
    providerOverrides: {
      "acp-fail-load": {
        extends: "acp",
        label: "ACP Fail Load",
        command: [process.execPath, path.resolve(import.meta.dirname, "acp-fail-load-fixture.cjs")],
      },
    },
  });
  cleanups.push(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanups.push(() => client.close());
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: "acp-fail-load",
    cwd: root,
  });
  await client.sendMessage(agent.id, "first");
  expect((await client.waitForFinish(agent.id, 10_000)).status).toBe("idle");

  await expect(client.refreshAgent(agent.id)).rejects.toThrow("session not saved");

  expect((await client.fetchAgent(agent.id))?.agent.status).not.toBe("closed");
  const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
  expect(
    timeline.entries.flatMap(({ item }) => (item.type === "assistant_message" ? [item.text] : [])),
  ).toContain("echo: first");
}, 60_000);
