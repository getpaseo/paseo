import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig, isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-claude-autonomous-simple-"));
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

describe("daemon E2E (real claude) - autonomous wake simple", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("hello + background sleep returns idle, then wakes once on completion", async () => {
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
        subscribe: { subscriptionId: "claude-autonomous-simple-real" },
      });

      const agent = await client.createAgent({
        cwd,
        title: "claude-autonomous-simple-real",
        ...getFullAccessConfig("claude"),
      });

      const autonomousWakeToken = `AUTONOMOUS_SIMPLE_${Date.now().toString(36)}`;
      await client.sendMessage(
        agent.id,
        [
          "Hello.",
          "Use the Bash tool with run_in_background.",
          "Run exactly: sleep 5",
          "Do not wait for the task result.",
          "Reply immediately with exactly: SPAWNED",
          `When the background task completes later, reply with exactly: ${autonomousWakeToken}`,
        ].join(" "),
      );

      const firstFinish = await client.waitForFinish(agent.id, 240_000);
      expect(firstFinish.status).toBe("idle");

      const timelineAtIdle = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      const idleAssistantText = timelineAtIdle.entries
        .filter(
          (
            entry,
          ): entry is typeof entry & {
            item: { type: "assistant_message"; text: string };
          } => entry.item.type === "assistant_message",
        )
        .map((entry) => entry.item.text)
        .join("\n");
      expect(compactText(idleAssistantText)).toContain("spawned");
      expect(
        timelineAtIdle.entries.some(
          (entry) => entry.item.type === "tool_call" && entry.item.name === "Bash",
        ),
      ).toBe(true);

      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
        30_000,
      );

      const autonomousFinish = await client.waitForFinish(agent.id, 120_000);
      expect(autonomousFinish.status).toBe("idle");

      const finalTimeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      const finalAssistantText = finalTimeline.entries
        .filter(
          (
            entry,
          ): entry is typeof entry & {
            item: { type: "assistant_message"; text: string };
          } => entry.item.type === "assistant_message",
        )
        .map((entry) => entry.item.text)
        .join("\n");
      expect(compactText(finalAssistantText)).toContain(autonomousWakeToken.toLowerCase());
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 420_000);
});
