import { beforeAll, beforeEach, describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { getFullAccessConfig, isProviderAvailable } from "./agent-configs.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-tool-interrupt-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasRunningToolCall(messages: SessionOutboundMessage[], agentId: string): boolean {
  for (const m of messages) {
    if (
      m.type === "agent_stream" &&
      m.payload.agentId === agentId &&
      m.payload.event.type === "timeline" &&
      m.payload.event.item.type === "tool_call" &&
      m.payload.event.item.status === "running"
    ) {
      return true;
    }
  }
  return false;
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

function countTurnStarted(messages: SessionOutboundMessage[], agentId: string): number {
  return messages.filter(
    (message) =>
      message.type === "agent_stream" &&
      message.payload.agentId === agentId &&
      message.payload.event.type === "turn_started",
  ).length;
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

function getStatusesBeforeFirstAssistant(
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
  if (firstAssistantIndex < 0) {
    return [];
  }
  return getAgentStatuses(messages.slice(0, firstAssistantIndex), agentId);
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

async function waitForRunningToolCall(
  client: DaemonClient,
  collector: ReturnType<typeof createMessageCollector>,
  agentId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasRunningToolCall(collector.messages, agentId)) {
      return;
    }

    const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 }).catch(() => null);
    const assistantTexts =
      timeline?.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .slice(-5)
        .map((entry) => entry.item.text) ?? [];
    const limitText = assistantTexts.find((text) => hasProviderLimitText(text));
    if (limitText) {
      throw new Error(
        `Claude could not reach the tool call because the provider rejected the run: ${limitText}`,
      );
    }
    if (
      timeline?.entries.some(
        (entry) =>
          entry.item.type === "tool_call" &&
          entry.item.name.toLowerCase() === "bash" &&
          entry.item.status === "running",
      )
    ) {
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
    `Timed out waiting for running tool call. Recent tool_calls=${JSON.stringify(recentToolCalls)} recent assistant text=${JSON.stringify(recentAssistantTexts)}`,
  );
}

describe("daemon E2E (real claude) - send message during tool call", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("sending a message while a tool call is running replaces the turn without error, idle flash, or autonomous fallback", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });

    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "primary" } });

      const agent = await client.createAgent({
        cwd,
        title: "tool-interrupt-repro",
        ...getFullAccessConfig("claude"),
      });

      const collector = createMessageCollector(client);

      // Step 1: Ask Claude to run sleep 60 in the foreground
      await client.sendMessage(
        agent.id,
        [
          "Use the Bash tool.",
          "Run exactly: sleep 60",
          "Do not use a background task.",
          "Do not do anything after starting the command.",
        ].join(" "),
      );

      // Step 2: Wait for the agent to be running
      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
        60_000,
      );

      // Step 3: Wait for a tool call to appear as "running" in the stream
      await waitForRunningToolCall(client, collector, agent.id);

      collector.clear();

      // Step 4: Send a second message while the tool call is still running
      await client.sendMessage(agent.id, "Reply with exactly: INTERRUPT_RECEIVED");

      // Step 5: Wait for the agent to finish — this is the critical assertion.
      // If the bug is present, the agent will stop and never start a new turn.
      const finish = await client.waitForFinish(agent.id, 120_000);
      const postSendMessages = [...collector.messages];
      const postSendAssistantTexts = getAssistantTexts(postSendMessages, agent.id);
      const postSendStatuses = getAgentStatuses(postSendMessages, agent.id);
      const statusesBeforeFirstAssistant = getStatusesBeforeFirstAssistant(
        postSendMessages,
        agent.id,
      );
      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });

      if (finish.status !== "idle") {
        const snapshot = await client.fetchAgent(agent.id);
        throw new Error(
          `Expected idle after replacement, got ${finish.status}. postSendStatuses=${JSON.stringify(postSendStatuses)} statusesBeforeFirstAssistant=${JSON.stringify(statusesBeforeFirstAssistant)} postSendAssistantTexts=${JSON.stringify(postSendAssistantTexts)} turnStarted=${countTurnStarted(postSendMessages, agent.id)} agentStatus=${snapshot?.agent.status ?? null} recentTimeline=${JSON.stringify(summarizeTimelineItems(timeline))}`,
        );
      }

      // Replacement should create exactly one new turn. A second turn_started here
      // means the reply got displaced onto a later autonomous wake.
      expect(countTurnStarted(postSendMessages, agent.id)).toBe(1);

      // The replacement path should not surface as agent error state.
      expect(postSendStatuses).not.toContain("error");

      // The agent should not flash idle before the replacement produces visible output.
      expect(statusesBeforeFirstAssistant).not.toContain("idle");
      expect(statusesBeforeFirstAssistant).not.toContain("error");

      // Step 6: Verify the agent actually responded to our second message
      const assistantTexts = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => {
          const item = entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>;
          return item.text;
        });

      // No system error messages should leak into the timeline
      const hasSystemError = assistantTexts.some((text) => text.includes("[System Error]"));
      expect(hasSystemError).toBe(false);
      expect(postSendAssistantTexts.some((text) => text.includes("[System Error]"))).toBe(false);

      const responded = assistantTexts.some((text) =>
        text.toUpperCase().includes("INTERRUPT_RECEIVED"),
      );
      expect(responded).toBe(true);

      collector.unsubscribe();
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
