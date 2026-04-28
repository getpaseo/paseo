import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { SessionOutboundMessage } from "../messages.js";
import { getFullAccessConfig, isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-codex-tool-interrupt-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateClientMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function getAgentStatuses(messages: SessionOutboundMessage[], agentId: string): string[] {
  return messages
    .filter(
      (message) =>
        message.type === "agent_update" &&
        message.payload.kind === "upsert" &&
        message.payload.agent.id === agentId,
    )
    .map((message) => message.payload.agent.status);
}

function getAgentStatusesBeforeFirstAssistant(
  messages: SessionOutboundMessage[],
  agentId: string,
): string[] {
  const firstAssistantIndex = messages.findIndex(
    (message) =>
      message.type === "agent_stream" &&
      message.payload.agentId === agentId &&
      message.payload.event.type === "timeline" &&
      message.payload.event.item.type === "assistant_message",
  );
  const observedPrefix =
    firstAssistantIndex < 0 ? messages : messages.slice(0, firstAssistantIndex);
  return getAgentStatuses(observedPrefix, agentId);
}

function getAssistantTexts(messages: SessionOutboundMessage[], agentId: string): string[] {
  return messages
    .filter(
      (message) =>
        message.type === "agent_stream" &&
        message.payload.agentId === agentId &&
        message.payload.event.type === "timeline" &&
        message.payload.event.item.type === "assistant_message",
    )
    .map((message) => message.payload.event.item.text);
}

function hasProviderLimitText(text: string): boolean {
  return /hit your limit|rate limit|quota|credits/i.test(text);
}

function assertNoProviderLimit(timeline: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>) {
  const assistantTexts = timeline.entries
    .filter((entry) => entry.item.type === "assistant_message")
    .slice(-5)
    .map((entry) => entry.item.text);
  const limitText = assistantTexts.find((text) => hasProviderLimitText(text));
  if (limitText) {
    throw new Error(`Codex provider rejected the run: ${limitText}`);
  }
}

function summarizeTimelineItems(timeline: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>) {
  return timeline.entries.slice(-15).map((entry) => {
    const item = entry.item;
    if (item.type === "assistant_message") {
      return { type: item.type, text: item.text };
    }
    if (item.type === "tool_call") {
      return {
        type: item.type,
        name: item.name,
        status: item.status,
        callId: item.callId,
      };
    }
    if (item.type === "user_message") {
      return { type: item.type, text: item.text };
    }
    return { type: item.type };
  });
}

async function waitForAssistantWaitingOnSleep(
  client: DaemonClient,
  agentId: string,
  timeoutMs = 75_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 });
    assertNoProviderLimit(timeline);
    const assistantText = timeline.entries
      .filter((entry) => entry.item.type === "assistant_message")
      .map((entry) => entry.item.text)
      .join("\n");
    if (/still running|waiting/i.test(assistantText) && !/`done`|\bdone\b/i.test(assistantText)) {
      return;
    }

    await sleep(500);
  }

  const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 }).catch(() => null);
  const recentToolCalls =
    timeline?.entries
      .filter((entry) => entry.item.type === "tool_call")
      .slice(-10)
      .map((entry) => ({
        name: entry.item.name,
        status: entry.item.status,
        callId: entry.item.callId,
      })) ?? [];
  const recentAssistantTexts =
    timeline?.entries
      .filter((entry) => entry.item.type === "assistant_message")
      .slice(-5)
      .map((entry) => entry.item.text) ?? [];
  throw new Error(
    `Timed out waiting for Codex to report it was waiting on sleep. Recent tool_calls=${JSON.stringify(recentToolCalls)} recent assistant text=${JSON.stringify(recentAssistantTexts)}`,
  );
}

describe("daemon E2E (real codex) - send message during tool call", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("codex");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("does not emit an idle agent_update between UI send and the replacement Codex turn", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: new CodexAppServerAgentClient(logger) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    let collector: ReturnType<typeof createMessageCollector> | null = null;

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "primary" } });

      const agent = await client.createAgent({
        cwd,
        title: "codex-tool-interrupt-repro",
        ...getFullAccessConfig("codex"),
      });

      collector = createMessageCollector(client);

      await client.sendMessage(
        agent.id,
        "Run `sleep 60 && echo done` and tell me what it outputs. Be brief.",
      );
      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
        60_000,
      );
      await waitForAssistantWaitingOnSleep(client, agent.id);

      collector.clear();

      await client.sendAgentMessage(agent.id, "Reply with exactly: INTERRUPT_RECEIVED", {
        messageId: generateClientMessageId(),
      });

      const finish = await client.waitForFinish(agent.id, 120_000);
      const postSendMessages = [...collector.messages];
      const postSendStatuses = getAgentStatuses(postSendMessages, agent.id);
      const statusesBeforeFirstAssistant = getAgentStatusesBeforeFirstAssistant(
        postSendMessages,
        agent.id,
      );
      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });

      if (finish.status !== "idle") {
        const snapshot = await client.fetchAgent(agent.id);
        throw new Error(
          `Expected idle after replacement, got ${finish.status}. postSendStatuses=${JSON.stringify(postSendStatuses)} statusesBeforeFirstAssistant=${JSON.stringify(statusesBeforeFirstAssistant)} postSendAssistantTexts=${JSON.stringify(getAssistantTexts(postSendMessages, agent.id))} agentStatus=${snapshot?.agent.status ?? null} recentTimeline=${JSON.stringify(summarizeTimelineItems(timeline))}`,
        );
      }

      expect(statusesBeforeFirstAssistant).not.toContain("idle");
      expect(statusesBeforeFirstAssistant).not.toContain("error");

      const assistantTexts = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => {
          const item = entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>;
          return item.text;
        });
      expect(assistantTexts.some((text) => text.includes("[System Error]"))).toBe(false);
      expect(assistantTexts.some((text) => text.toUpperCase().includes("INTERRUPT_RECEIVED"))).toBe(
        true,
      );
    } finally {
      collector?.unsubscribe();
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  test("does not emit an idle agent_update when a second prompt is sent 200ms after the first", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: new CodexAppServerAgentClient(logger) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    let collector: ReturnType<typeof createMessageCollector> | null = null;

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "primary" } });

      const agent = await client.createAgent({
        cwd,
        title: "codex-quick-follow-up-repro",
        ...getFullAccessConfig("codex"),
      });

      collector = createMessageCollector(client);

      await client.sendAgentMessage(
        agent.id,
        "Run `sleep 60 && echo done` and tell me what it outputs. Be brief.",
        {
          messageId: generateClientMessageId(),
        },
      );
      await sleep(200);

      collector.clear();

      await client.sendAgentMessage(agent.id, "Reply with exactly: QUICK_FOLLOW_UP_RECEIVED", {
        messageId: generateClientMessageId(),
      });

      const finish = await client.waitForFinish(agent.id, 120_000);
      const postSendMessages = [...collector.messages];
      const postSendStatuses = getAgentStatuses(postSendMessages, agent.id);
      const statusesBeforeFirstAssistant = getAgentStatusesBeforeFirstAssistant(
        postSendMessages,
        agent.id,
      );
      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });

      if (finish.status !== "idle") {
        const snapshot = await client.fetchAgent(agent.id);
        throw new Error(
          `Expected idle after quick follow-up, got ${finish.status}. postSendStatuses=${JSON.stringify(postSendStatuses)} statusesBeforeFirstAssistant=${JSON.stringify(statusesBeforeFirstAssistant)} postSendAssistantTexts=${JSON.stringify(getAssistantTexts(postSendMessages, agent.id))} agentStatus=${snapshot?.agent.status ?? null} recentTimeline=${JSON.stringify(summarizeTimelineItems(timeline))}`,
        );
      }

      expect(statusesBeforeFirstAssistant).not.toContain("idle");
      expect(statusesBeforeFirstAssistant).not.toContain("error");

      const assistantTexts = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => {
          const item = entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>;
          return item.text;
        });
      expect(assistantTexts.some((text) => text.includes("[System Error]"))).toBe(false);
      expect(
        assistantTexts.some((text) => text.toUpperCase().includes("QUICK_FOLLOW_UP_RECEIVED")),
      ).toBe(true);
    } finally {
      collector?.unsubscribe();
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
