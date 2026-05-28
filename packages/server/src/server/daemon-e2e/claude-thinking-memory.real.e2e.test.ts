import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig, isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-claude-thinking-memory-"));
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function assistantMessages(items: AgentTimelineItem[]): string[] {
  return items
    .filter(
      (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
        item.type === "assistant_message",
    )
    .map((item) => item.text);
}

function modelHasLowThinkingOption(model: {
  id: string;
  thinkingOptions?: Array<{ id: string }>;
}): boolean {
  const thinkingOptionIds = new Set(model.thinkingOptions?.map((option) => option.id) ?? []);
  return model.id.includes("sonnet") && thinkingOptionIds.has("low");
}

async function getAssistantText(client: DaemonClient, agentId: string): Promise<string> {
  const timeline = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  return assistantMessages(timeline.entries.map((entry) => entry.item)).join("\n");
}

describe("daemon E2E (real claude) - thinking effort memory", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("changing thinking effort preserves the previous conversation", async () => {
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
        subscribe: { subscriptionId: "claude-thinking-memory-real" },
      });

      const modelList = await client.listProviderModels("claude", { cwd });
      const model = modelList.models.find(modelHasLowThinkingOption);
      if (!model) {
        throw new Error("No Claude Sonnet model with low thinking effort returned");
      }

      const agent = await client.createAgent({
        cwd,
        title: "claude-thinking-memory-real",
        ...getFullAccessConfig("claude"),
        model: model.id,
      });

      await client.sendMessage(
        agent.id,
        "Remember the code phrase PASEO_MEMORY_56. Reply exactly: ACK_56",
      );
      const firstFinish = await client.waitForFinish(agent.id, 180_000);
      expect(firstFinish.status).toBe("idle");
      expect(firstFinish.final?.lastError).toBeUndefined();
      expect(compactText(await getAssistantText(client, agent.id))).toContain("ack_56");

      await client.setAgentThinkingOption(agent.id, "low");

      await client.sendMessage(
        agent.id,
        "What code phrase did I ask you to remember? Reply exactly with that code phrase and nothing else.",
      );
      const secondFinish = await client.waitForFinish(agent.id, 180_000);
      expect(secondFinish.status).toBe("idle");
      expect(secondFinish.final?.lastError).toBeUndefined();

      const assistantText = await getAssistantText(client, agent.id);
      expect(compactText(assistantText)).toContain("paseo_memory_56");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 420_000);
});
