import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { canRunRealProvider, getRealProviderConfig } from "./real-provider-test-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-claude-steer-compaction-"));
}

type TimelineItem = Awaited<
  ReturnType<DaemonClient["fetchAgentTimeline"]>
>["entries"][number]["item"];

// The steer must land while the compaction is still running, or it takes the idle path.
function isCompacting(items: TimelineItem[]): boolean {
  const statuses = new Set(
    items.flatMap((item) => (item.type === "compaction" ? [item.status] : [])),
  );
  return statuses.has("loading") && !statuses.has("completed");
}

function hasAssistantText(items: TimelineItem[], text: string): boolean {
  return items.some((item) => item.type === "assistant_message" && item.text.includes(text));
}

async function timelineItems(client: DaemonClient, agentId: string): Promise<TimelineItem[]> {
  const timeline = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 200,
  });
  return timeline.entries.map((entry) => entry.item);
}

async function waitForTimeline(
  client: DaemonClient,
  agentId: string,
  check: (items: TimelineItem[]) => boolean,
  timeoutMs: number,
  label: string,
): Promise<TimelineItem[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await timelineItems(client, agentId);
    if (check(items)) return items;
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${label}: ${JSON.stringify(items.slice(-6)).slice(0, 2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("daemon E2E (real claude) - steer during compaction", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
  });

  beforeEach((context) => {
    if (!canRun) context.skip();
  });

  test("a steered message waits for a running /compact instead of cancelling it", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
    });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const agent = await client.createAgent({
        cwd,
        title: "claude-steer-during-compaction",
        ...getRealProviderConfig("claude"),
      });
      await client.sendAgentMessage(
        agent.id,
        `Remember this list for later and reply exactly: NOTED. ${Array.from(
          { length: 400 },
          (_, index) => `item-${index}`,
        ).join(" ")}`,
      );
      const firstFinish = await client.waitForFinish(agent.id, 120_000);
      expect(firstFinish.status, firstFinish.error).toBe("idle");

      await client.sendAgentMessage(agent.id, "/compact");
      await waitForTimeline(client, agent.id, isCompacting, 60_000, "Claude reports compacting");

      await client.sendAgentMessage(agent.id, "Reply exactly: AFTER_COMPACT", {
        activeTurnBehavior: "steer",
      });
      await waitForTimeline(
        client,
        agent.id,
        (items) => hasAssistantText(items, "AFTER_COMPACT"),
        180_000,
        "Claude answers the steered message",
      );
      await client.waitForFinish(agent.id, 120_000);
      const finalItems = await timelineItems(client, agent.id);
      expect(
        finalItems.filter((item) => item.type === "compaction").map((item) => item.status),
      ).toContain("completed");
      expect(hasAssistantText(finalItems, "Compaction canceled")).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 420_000);
});
