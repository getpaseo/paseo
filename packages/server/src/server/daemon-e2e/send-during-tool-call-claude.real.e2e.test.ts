import { beforeAll, beforeEach, describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-tool-interrupt-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(label: string, timeoutMs: number, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function generateClientMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

interface ObservedForegroundSleep {
  callId: string;
  turnId?: string;
}

function getRunningClaudeSleep(
  message: SessionOutboundMessage,
  agentId: string,
): ObservedForegroundSleep | null {
  if (
    message.type !== "agent_stream" ||
    message.payload.agentId !== agentId ||
    message.payload.event.type !== "timeline" ||
    message.payload.event.item.type !== "tool_call"
  ) {
    return null;
  }
  const tool = message.payload.event.item;
  if (
    tool.status !== "running" ||
    tool.detail.type !== "shell" ||
    !/\bsleep 5\b/.test(tool.detail.command)
  ) {
    return null;
  }
  return { callId: tool.callId, turnId: message.payload.event.turnId };
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

function isCapturedSleepCompletion(
  message: SessionOutboundMessage,
  agentId: string,
  callId: string,
): boolean {
  return (
    message.type === "agent_stream" &&
    message.payload.agentId === agentId &&
    message.payload.event.type === "timeline" &&
    message.payload.event.item.type === "tool_call" &&
    message.payload.event.item.callId === callId &&
    message.payload.event.item.status === "completed"
  );
}

function isCapturedSleepCancellation(
  message: SessionOutboundMessage,
  agentId: string,
  callId: string,
): boolean {
  return (
    message.type === "agent_stream" &&
    message.payload.agentId === agentId &&
    message.payload.event.type === "timeline" &&
    message.payload.event.item.type === "tool_call" &&
    message.payload.event.item.callId === callId &&
    (message.payload.event.item.status === "canceled" ||
      message.payload.event.item.status === "failed")
  );
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
  const snapshot = await client.fetchAgent({ agentId }).catch(() => null);
  const streamFailures = collector.messages
    .filter(
      (message) =>
        message.type === "agent_stream" &&
        message.payload.agentId === agentId &&
        (message.payload.event.type === "turn_failed" ||
          message.payload.event.type === "turn_canceled"),
    )
    .map((message) => message.payload.event);
  const permissionEvents = collector.messages
    .filter(
      (message) =>
        message.type === "agent_stream" &&
        message.payload.agentId === agentId &&
        message.payload.event.type === "permission_requested",
    )
    .map((message) => message.payload.event);
  throw new Error(
    `Timed out waiting for running tool call. lifecycle=${snapshot?.agent.status ?? "missing"} activeTurn=${snapshot?.agent.activeForegroundTurnId ?? "none"} recent tool_calls=${JSON.stringify(recentToolCalls)} recent assistant text=${JSON.stringify(recentAssistantTexts)} stream failures=${JSON.stringify(streamFailures)} permissions=${JSON.stringify(permissionEvents)}`,
  );
}

async function waitForRunningClaudeSleep(
  client: DaemonClient,
  collector: ReturnType<typeof createMessageCollector>,
  agentId: string,
  timeoutMs = 90_000,
): Promise<ObservedForegroundSleep> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = collector.messages
      .map((message) => getRunningClaudeSleep(message, agentId))
      .find((event): event is ObservedForegroundSleep => event !== null);
    if (observed) {
      return observed;
    }

    // Projection is only diagnostic here; tool lifecycle rows are collapsed by fetch.
    const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 }).catch(() => null);
    const assistantTexts =
      timeline?.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .slice(-5)
        .map((entry) => entry.item.text) ?? [];
    const limitText = assistantTexts.find((text) => hasProviderLimitText(text));
    if (limitText) {
      throw new Error(`Claude provider rejected the run: ${limitText}`);
    }
    await sleep(50);
  }

  const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 }).catch(() => null);
  throw new Error(
    `Timed out waiting for Claude to report the live foreground sleep 5 call. Recent timeline=${JSON.stringify(timeline ? summarizeTimelineItems(timeline) : [])}`,
  );
}

describe("daemon E2E (real claude) - send message during tool call", () => {
  let canRun = false;
  interface SteeringResources {
    cwd: string | null;
    daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | null;
    client: DaemonClient | null;
    collector: ReturnType<typeof createMessageCollector> | null;
  }

  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("steers one active Claude turn without starting another", async () => {
    const logger = pino({ level: "silent" });
    const resources: SteeringResources = {
      cwd: tmpCwd(),
      daemon: null,
      client: null,
      collector: null,
    };
    try {
      resources.daemon = await createTestPaseoDaemon({
        // Use the installed SDK's configured authentication so this regression
        // exercises the native streaming-input path.
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      resources.client = new DaemonClient({ url: `ws://127.0.0.1:${resources.daemon.port}/ws` });
      const { client, cwd } = resources;
      if (!client) throw new Error("Claude steering test client was not created");
      await within("connect Claude steering test client", 15_000, client.connect());
      await within(
        "subscribe Claude steering test client",
        15_000,
        client.fetchAgents({ subscribe: { subscriptionId: "steer" } }),
      );
      const agent = await within(
        "create Claude steering test agent",
        30_000,
        client.createAgent({
          cwd: cwd ?? process.cwd(),
          title: "claude-exact-turn-steer",
          ...getRealProviderConfig("claude"),
        }),
      );
      resources.collector = createMessageCollector(client);
      await within(
        "submit Claude foreground sleep turn",
        30_000,
        client.sendAgentMessage(
          agent.id,
          [
            "Use the Bash tool.",
            "Run exactly: sleep 5. Run it in the foreground. Do not finish until a later user message arrives.",
            "After that message arrives, use the Bash tool again and run exactly: printf SECOND_BOUNDARY. Then reply exactly: STEERED_SAME_TURN.",
            "Do not use a background task.",
          ].join(" "),
          { messageId: generateClientMessageId() },
        ),
      );
      const foregroundSleep = await within(
        "wait for Claude to begin the live foreground sleep tool",
        90_000,
        waitForRunningClaudeSleep(client, resources.collector, agent.id, 80_000),
      );
      await within(
        "confirm Claude remains active at the first tool boundary",
        15_000,
        client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running", 10_000),
      );
      const initialTurnStarts = resources.collector.messages.filter(
        (message) =>
          message.type === "agent_stream" &&
          message.payload.agentId === agent.id &&
          message.payload.event.type === "turn_started",
      );
      expect(initialTurnStarts).toHaveLength(1);
      const initialTurnId = initialTurnStarts[0]?.payload.event.turnId;
      expect(initialTurnId).toEqual(expect.any(String));
      expect(foregroundSleep.turnId).toBe(initialTurnId);
      const steeringMessageId = generateClientMessageId();
      const messagesBeforeSteer = resources.collector.messages.length;
      await within(
        "submit Claude active-turn steer",
        30_000,
        client.sendAgentMessage(agent.id, "hello", {
          messageId: steeringMessageId,
          activeTurnBehavior: "steer",
        }),
      );
      const finish = await within(
        "wait for steered Claude turn to finish",
        150_000,
        client.waitForFinish(agent.id, 140_000),
      );
      expect(finish.status).toBe("idle");
      const postSteerMessages = resources.collector.messages.slice(messagesBeforeSteer);
      const turnStarts = postSteerMessages.filter(
        (message) =>
          message.type === "agent_stream" &&
          message.payload.agentId === agent.id &&
          message.payload.event.type === "turn_started",
      );
      expect(turnStarts).toHaveLength(0);
      expect(
        postSteerMessages.filter(
          (message) =>
            message.type === "agent_stream" &&
            message.payload.agentId === agent.id &&
            message.payload.event.type === "turn_canceled",
        ),
      ).toHaveLength(0);
      expect(
        postSteerMessages.filter(
          (message) =>
            message.type === "agent_stream" &&
            message.payload.agentId === agent.id &&
            message.payload.event.type === "turn_completed",
        ),
      ).toHaveLength(1);
      expect(
        postSteerMessages.some((message) =>
          isCapturedSleepCompletion(message, agent.id, foregroundSleep.callId),
        ),
        "the exact live sleep 5 call must complete after hello is submitted",
      ).toBe(true);
      expect(
        postSteerMessages.some((message) =>
          isCapturedSleepCancellation(message, agent.id, foregroundSleep.callId),
        ),
        "the exact live sleep 5 call must not be canceled or fail after hello",
      ).toBe(false);
      const secondBoundaryEvents = postSteerMessages.filter(
        (message) =>
          message.type === "agent_stream" &&
          message.payload.agentId === agent.id &&
          message.payload.event.type === "timeline" &&
          message.payload.event.item.type === "tool_call" &&
          message.payload.event.item.detail.type === "shell" &&
          /\bprintf\s+SECOND_BOUNDARY\b/.test(message.payload.event.item.detail.command),
      );
      expect(
        secondBoundaryEvents.some(
          (message) =>
            message.payload.event.type === "timeline" &&
            message.payload.event.item.type === "tool_call" &&
            message.payload.event.item.status === "completed",
        ),
        "hello must drive a second completed tool call in the same active loop",
      ).toBe(true);
      expect(
        secondBoundaryEvents.every(
          (message) =>
            message.payload.event.type === "timeline" &&
            message.payload.event.turnId === initialTurnId,
        ),
        "both Claude tool boundaries must retain the original turn ID",
      ).toBe(true);
      const timeline = await within(
        "fetch steered Claude timeline",
        15_000,
        client.fetchAgentTimeline(agent.id, { limit: 100 }),
      );
      const assistantText = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map(
          (entry) => (entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>).text,
        )
        .join("\\n");
      const steeringRows = timeline.entries.filter(
        (entry) => entry.item.type === "user_message" && entry.item.text === "hello",
      );
      expect(steeringRows).toHaveLength(1);
      expect(steeringRows[0]?.item).toMatchObject({
        messageId: steeringMessageId,
        clientMessageId: steeringMessageId,
      });
      expect(steeringRows[0]?.turnId).toBe(initialTurnId);
      expect(assistantText).toContain("STEERED_SAME_TURN");
    } finally {
      const cleanup = await Promise.allSettled([
        Promise.resolve(resources.collector?.unsubscribe()),
        resources.client?.close() ?? Promise.resolve(),
        resources.daemon?.close() ?? Promise.resolve(),
      ]);
      if (resources.cwd) rmSync(resources.cwd, { recursive: true, force: true });
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      expect(failures, "Claude steering E2E cleanup failures").toEqual([]);
    }
  }, 210_000);

  test("sending a message while a tool call is running replaces the turn without error, idle flash, or autonomous fallback", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["claude"], logger),
      logger,
    });

    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "primary" } });

      const agent = await client.createAgent({
        cwd,
        title: "tool-interrupt-repro",
        ...getRealProviderConfig("claude"),
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
        const snapshot = await client.fetchAgent({ agentId: agent.id });
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
