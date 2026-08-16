import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { SessionOutboundMessage } from "../messages.js";
import { canRunRealProvider } from "./real-provider-test-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-codex-tool-interrupt-"));
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

interface ObservedForegroundSleep {
  callId: string;
}

function getRunningCodexSleep(
  message: SessionOutboundMessage,
  agentId: string,
  command: RegExp,
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
    !command.test(tool.detail.command)
  ) {
    return null;
  }
  return { callId: tool.callId };
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

async function waitForRunningCodexSleep(
  client: DaemonClient,
  collector: ReturnType<typeof createMessageCollector>,
  agentId: string,
  timeoutMs = 75_000,
  command = /\bsleep 5\b/,
): Promise<ObservedForegroundSleep> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = collector.messages
      .map((message) => getRunningCodexSleep(message, agentId, command))
      .find((event): event is ObservedForegroundSleep => event !== null);
    if (observed) {
      return observed;
    }
    // Timeline fetches are diagnostic only: projection collapses the lifecycle row.
    const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 }).catch(() => null);
    if (timeline) assertNoProviderLimit(timeline);
    await sleep(50);
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
  interface SteeringResources {
    cwd: string | null;
    daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | null;
    client: DaemonClient | null;
    collector: ReturnType<typeof createMessageCollector> | null;
  }

  beforeAll(async () => {
    canRun = await canRunRealProvider("codex");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("steers one active Codex turn without starting another", async () => {
    const logger = pino({ level: "silent" });
    const resources: SteeringResources = {
      cwd: tmpCwd(),
      daemon: null,
      client: null,
      collector: null,
    };
    try {
      resources.daemon = await createTestPaseoDaemon({
        // Use the installed app-server so this regression exercises the native
        // steering method rather than the broad provider smoke-test path.
        agentClients: { codex: new CodexAppServerAgentClient(logger) },
        logger,
      });
      resources.client = new DaemonClient({ url: `ws://127.0.0.1:${resources.daemon.port}/ws` });
      const { client, cwd } = resources;
      if (!client) throw new Error("Codex steering test client was not created");
      await within("connect steering test client", 15_000, client.connect());
      await within(
        "subscribe steering test client",
        15_000,
        client.fetchAgents({ subscribe: { subscriptionId: "steer" } }),
      );
      const agent = await within(
        "create Codex steering test agent",
        30_000,
        client.createAgent({
          cwd: cwd ?? process.cwd(),
          title: "codex-exact-turn-steer",
          provider: "codex",
          model: "gpt-5.4",
          thinkingOptionId: "low",
          modeId: "full-access",
        }),
      );
      resources.collector = createMessageCollector(client);
      await within(
        "submit Codex foreground sleep turn",
        30_000,
        client.sendAgentMessage(
          agent.id,
          "Use the shell tool to run exactly: sleep 5. Run it in the foreground. Do not finish until a later user message arrives; after it arrives, reply exactly: STEERED_SAME_TURN.",
          { messageId: generateClientMessageId() },
        ),
      );
      const foregroundSleep = await within(
        "wait for live Codex foreground sleep tool",
        90_000,
        waitForRunningCodexSleep(client, resources.collector, agent.id, 80_000),
      );
      await within(
        "confirm Codex remains active at the first tool boundary",
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
      const steeringMessageId = generateClientMessageId();
      const messagesBeforeSteer = resources.collector.messages.length;
      await within(
        "submit Codex active-turn steer",
        30_000,
        client.sendAgentMessage(agent.id, "hello", {
          messageId: steeringMessageId,
          activeTurnBehavior: "steer",
        }),
      );
      const finish = await within(
        "wait for steered Codex turn to finish",
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
      const timeline = await within(
        "fetch steered Codex timeline",
        15_000,
        client.fetchAgentTimeline(agent.id, { limit: 100 }),
      );
      const assistantText = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map(
          (entry) => (entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>).text,
        )
        .join("\n");
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
      expect(failures, "Codex steering E2E cleanup failures").toEqual([]);
    }
  }, 210_000);

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
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "low",
        modeId: "full-access",
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
      await waitForRunningCodexSleep(client, collector, agent.id, 75_000, /\bsleep 60\b/);

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
        const snapshot = await client.fetchAgent({ agentId: agent.id });
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
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "low",
        modeId: "full-access",
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
        const snapshot = await client.fetchAgent({ agentId: agent.id });
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
