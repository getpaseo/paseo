import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentTimelineItem, ToolCallTimelineItem } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig, isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-tool-result-images-"));
}

function toolCalls(items: AgentTimelineItem[]): ToolCallTimelineItem[] {
  return items.filter((item): item is ToolCallTimelineItem => item.type === "tool_call");
}

describe("daemon E2E (real claude) - tool result images", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("Read on a PNG surfaces image blocks on the tool_call timeline item", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const pngPath = path.join(cwd, "red.png");
    cpSync(path.resolve(__dirname, "fixtures/red-pixel.png"), pngPath);

    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({
        subscribe: { subscriptionId: "tool-result-images-real" },
      });

      const agent = await client.createAgent({
        cwd,
        title: "tool-result-images-real",
        ...getFullAccessConfig("claude"),
      });

      await client.sendMessage(
        agent.id,
        `Please read the file at ${pngPath} using the Read tool. Then reply with just the word "done".`,
      );
      const finished = await client.waitForFinish(agent.id, 180_000);
      expect(finished.status).toBe("idle");
      expect(finished.final?.lastError).toBeUndefined();

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      const items = timeline.entries.map((entry) => entry.item);
      const readCall = toolCalls(items).find(
        (call) => call.name === "Read" && call.status === "completed",
      );
      expect(readCall, "expected a completed Read tool call").toBeDefined();
      expect(readCall?.images?.length ?? 0).toBeGreaterThan(0);
      // Fixture is a PNG; assert the exact type so a regression that mis-tags
      // the mime would be caught here rather than passing a permissive regex.
      expect(readCall?.images?.[0].mimeType).toBe("image/png");
      expect(readCall?.images?.[0].data.length).toBeGreaterThan(0);

      await client.deleteAgent(agent.id);
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
