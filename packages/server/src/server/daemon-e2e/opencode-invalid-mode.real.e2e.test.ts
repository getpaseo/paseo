import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-invalid-mode-"));
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
  await client.fetchAgents({ subscribe: { subscriptionId: "opencode-invalid-mode" } });
  return { client, daemon };
}

describe("daemon E2E (real opencode) - invalid mode handling", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("initial prompt with a nonexistent OpenCode mode fails instead of hanging forever", async () => {
    const cwd = tmpCwd();
    const { client, daemon } = await createHarness();

    try {
      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode invalid mode regression",
        modeId: "definitely-not-a-real-mode",
        initialPrompt: "hello",
      });

      const finish = await client.waitForFinish(agent.id, 30_000);
      expect(finish.status).toBe("error");
      expect(finish.error).toBeTruthy();

      const snapshot = await client.fetchAgent(agent.id);
      expect(snapshot.agent?.status).toBe("error");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
