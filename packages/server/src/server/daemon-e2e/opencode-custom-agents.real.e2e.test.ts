import { beforeAll, beforeEach, describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-custom-"));
}

async function createHarness(): Promise<{
  client: DaemonClient;
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>;
}> {
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: { opencode: new OpenCodeAgentClient(logger) },
    logger,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "opencode-custom-agents" } });
  return { client, daemon };
}

describe("daemon E2E (real opencode) - custom agent discovery", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("custom agents defined in opencode.json appear in availableModes", async () => {
    const cwd = tmpCwd();
    writeFileSync(
      path.join(cwd, "opencode.json"),
      JSON.stringify({
        agent: {
          "paseo-e2e-custom": {
            description: "Custom agent for Paseo daemon E2E test",
            mode: "primary",
          },
        },
      }),
    );

    const { client, daemon } = await createHarness();

    try {
      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode custom agent discovery",
      });

      // Wait for modes to be populated (they arrive after session init)
      const snapshot = await client.waitForAgentUpsert(
        agent.id,
        (s) => s.availableModes.length > 0,
        30_000,
      );

      expect(snapshot.availableModes.some((m) => m.id === "build")).toBe(true);
      expect(snapshot.availableModes.some((m) => m.id === "plan")).toBe(true);

      const custom = snapshot.availableModes.find((m) => m.id === "paseo-e2e-custom");
      expect(custom).toBeDefined();
      expect(custom!.description).toBe("Custom agent for Paseo daemon E2E test");

      // System agents should not leak through
      expect(snapshot.availableModes.some((m) => m.id === "compaction")).toBe(false);
      expect(snapshot.availableModes.some((m) => m.id === "summary")).toBe(false);
      expect(snapshot.availableModes.some((m) => m.id === "title")).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
