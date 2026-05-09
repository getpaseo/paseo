import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-claude-model-init-"));
}

describe("daemon E2E (real claude) - model resolution on init", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("runtimeInfo.model is set as soon as the agent starts running, not after turn completes", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({
        subscribe: { subscriptionId: "model-init-test" },
      });

      const modelsResult = await client.listProviderModels("claude", { cwd });
      const catalogModelIds = new Set(modelsResult.models.map((m) => m.id));

      const agent = await client.createAgent({
        provider: "claude",
        cwd,
        model: "haiku",
        title: "model-init-test",
      });

      await client.sendMessage(agent.id, "Reply with exactly: OK");

      const snapshot = await client.waitForAgentUpsert(
        agent.id,
        (s) => s.runtimeInfo?.model != null,
        60_000,
      );

      expect(snapshot.runtimeInfo?.model).toBeTruthy();
      expect(catalogModelIds.has(snapshot.runtimeInfo!.model!)).toBe(true);
      expect(snapshot.status).toBe("running");

      await client.waitForFinish(agent.id, 60_000);
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
