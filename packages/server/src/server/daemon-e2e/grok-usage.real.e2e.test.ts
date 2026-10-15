import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("publishes Grok context usage through the daemon agent snapshot", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-grok-usage-"));
  const daemon = await createTestPaseoDaemon({
    logger: pino({ level: "silent" }),
    agentClients: {},
    providerOverrides: {
      grok: {
        extends: "acp",
        label: "Grok",
        command: ["grok", "agent", "stdio"],
      },
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.2",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({ provider: "grok", cwd });
    await client.sendMessage(agent.id, "Reply with exactly pong. Do not use tools.");

    const finished = await client.waitForFinish(agent.id, 60_000);
    expect(finished.status).toBe("idle");
    const { agent: snapshot } = await client.fetchAgent({ agentId: agent.id });
    expect(snapshot.lastUsage).toEqual({
      contextWindowMaxTokens: expect.any(Number),
      contextWindowUsedTokens: expect.any(Number),
    });
    expect(snapshot.lastUsage?.contextWindowMaxTokens).toBeGreaterThan(0);
    expect(snapshot.lastUsage?.contextWindowUsedTokens).toBeGreaterThan(0);
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
