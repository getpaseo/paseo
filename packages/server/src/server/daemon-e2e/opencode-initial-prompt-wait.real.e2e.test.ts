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
  return mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-init-prompt-"));
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
  await client.fetchAgents({ subscribe: { subscriptionId: "opencode-init-prompt" } });
  return { client, daemon };
}

describe("daemon E2E (real opencode) - initial prompt wait", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("waitForFinish does not resolve before an initial prompt using opencode/big-pickle actually completes", async () => {
    const cwd = tmpCwd();
    const { client, daemon } = await createHarness();

    try {
      const models = await client.listProviderModels("opencode");
      expect(models.models.some((model) => model.id === "zai/glm-5.1")).toBe(true);

      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode initial prompt wait regression",
        model: "opencode/big-pickle",
        initialPrompt: "Reply with exactly: BIG_PICKLE_OK",
      });

      const finish = await client.waitForFinish(agent.id, 60_000);
      expect(finish.status).toBe("idle");
      expect(finish.lastMessage).toContain("BIG_PICKLE_OK");

      const snapshot = await client.fetchAgent(agent.id);
      expect(snapshot.agent?.status).toBe("idle");

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "projected",
      });
      const assistantMessages = timeline.entries.filter(
        (entry) => entry.item.type === "assistant_message",
      );

      expect(assistantMessages.length).toBeGreaterThan(0);
      expect(assistantMessages.some((entry) => entry.item.text.includes("BIG_PICKLE_OK"))).toBe(
        true,
      );
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  test("waitForFinish surfaces a terminal error when zai/glm-5.1 enters a fatal retry loop", async () => {
    const cwd = tmpCwd();
    const { client, daemon } = await createHarness();

    try {
      const models = await client.listProviderModels("opencode");
      expect(models.models.some((model) => model.id === "zai/glm-5.1")).toBe(true);

      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode zai fatal retry regression",
        model: "zai/glm-5.1",
        initialPrompt: "Reply with exactly: GLM_51_OK",
      });

      const finish = await client.waitForFinish(agent.id, 60_000);
      expect(finish.status).toBe("error");
      expect((finish.error ?? "").toLowerCase()).toMatch(
        /insufficient balance|resource package|recharge/,
      );

      const snapshot = await client.fetchAgent(agent.id);
      expect(snapshot.agent?.status).toBe("error");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});
