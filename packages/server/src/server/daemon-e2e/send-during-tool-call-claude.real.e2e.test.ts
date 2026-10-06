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

// Explicit point-in-time polls of agent status, on top of (not instead of) the pushed
// agent_update events the collector already records. A phantom "running" flip that starts and
// ends between two polls would still be caught by the pushed-event scan the callers pair this
// with; polling here additionally proves the daemon answers fetchAgent with "idle" throughout,
// not just that it eventually pushes one.
async function sampleAgentStatuses(
  client: DaemonClient,
  agentId: string,
  samples: number,
  intervalMs: number,
): Promise<string[]> {
  const statuses: string[] = [];
  for (let i = 0; i < samples; i += 1) {
    const snapshot = await client.fetchAgent({ agentId });
    statuses.push(snapshot?.agent.status ?? "missing");
    if (i < samples - 1) {
      await sleep(intervalMs);
    }
  }
  return statuses;
}

// NOTE: agent_stream events on the wire (AgentStreamEventPayloadSchema in
// packages/protocol/src/messages.ts) do not include a "provider_subagent" variant. A backgrounded
// subagent's descriptor updates are forwarded exclusively as separate "agent.provider_subagents.update"
// messages (see forwardProviderSubagentUpdate in session.ts), and that push channel's delivery is
// gated by capabilities this test's plain DaemonClient does not declare. list_provider_subagents is a
// plain request/response RPC unaffected by that gating, so status history below polls it directly
// instead of trying to reconstruct status transitions from the stream.
type ProviderSubagentDescriptor = Awaited<
  ReturnType<DaemonClient["listProviderSubagents"]>
>["subagents"][number];

interface ProviderSubagentPoll {
  subagent: ProviderSubagentDescriptor;
  // Every status observed while polling, in order, so a transient cancel cannot hide behind a
  // later "completed" read even though the store's status field is not expected to un-cancel.
  history: string[];
}

// Polls agent.provider_subagents.list until the backgrounded helper is registered at all.
// "Main's turn is running" (waitForAgentUpsert) fires on generic turn-start bookkeeping, which
// can be true before Claude has actually issued the Agent tool call; canceling that early
// cancels a turn with no helper launched yet, which is not what "Stop spares a helper" means to
// test. This confirms the helper actually exists before the caller acts on it.
async function waitForProviderSubagentToExist(
  client: DaemonClient,
  agentId: string,
  timeoutMs = 60_000,
): Promise<ProviderSubagentDescriptor> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { subagents } = await client.listProviderSubagents(agentId);
    if (subagents[0]) {
      return subagents[0];
    }
    await sleep(300);
  }
  throw new Error(
    `Timed out waiting for a background helper to be registered for agent ${agentId}`,
  );
}

// Claude starts the wake-up turn a moment after the helper's completion lands (0.1 to 5 s in
// recorded traces), so poll for it instead of checking the instant the helper reads completed.
// The daemon announces an autonomous turn to subscribers as a pushed "running" agent_update,
// not as an agent_stream turn_started (that stream reaches the client that started a run).
async function waitForWakeTurn(
  collector: ReturnType<typeof createMessageCollector>,
  agentId: string,
  fromIndex: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const window = collector.messages.slice(fromIndex);
    const woke =
      getAgentStatuses(window, agentId).includes("running") ||
      window.some(
        (message) =>
          message.type === "agent_stream" &&
          message.payload.agentId === agentId &&
          message.payload.event.type === "turn_started",
      );
    if (woke) return true;
    await sleep(500);
  }
  return false;
}

// The wake-up turn runs briefly after it opens, so the final state is read once it settles.
async function waitForAgentStatus(
  client: DaemonClient,
  agentId: string,
  status: string,
  timeoutMs = 60_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    last = (await client.fetchAgent({ agentId }))?.agent.status;
    if (last === status) return last;
    await sleep(500);
  }
  return last;
}

// Polls agent.provider_subagents.list until the single backgrounded helper leaves "running".
// Scenarios in this file always launch exactly one background helper, so subagents[0] is it.
async function waitForProviderSubagentTerminal(
  client: DaemonClient,
  agentId: string,
  timeoutMs = 90_000,
): Promise<ProviderSubagentPoll> {
  const deadline = Date.now() + timeoutMs;
  const history: string[] = [];
  let lastSeen: ProviderSubagentDescriptor[] = [];
  while (Date.now() < deadline) {
    const { subagents } = await client.listProviderSubagents(agentId);
    lastSeen = subagents;
    const subagent = subagents[0];
    if (subagent) {
      history.push(subagent.status);
      if (subagent.status !== "running") {
        return { subagent, history };
      }
    }
    await sleep(1_000);
  }
  throw new Error(
    `Timed out waiting for the background helper to leave "running". history=${JSON.stringify(history)} lastSeen=${JSON.stringify(lastSeen)}`,
  );
}

// Pulls the main agent's own assistant text via fetchAgentTimeline rather than the push
// collector. Assistant text delivery is paced (docs/agent-stream-performance.md), so checking
// the collector immediately after waitForFinish resolves can still miss the final text; the
// timeline fetch is authoritative and matches what the pre-existing tests in this file do.
async function fetchAssistantTexts(
  client: DaemonClient,
  agentId: string,
  limit = 100,
): Promise<string[]> {
  const timeline = await client.fetchAgentTimeline(agentId, { limit });
  return timeline.entries
    .filter((entry) => entry.item.type === "assistant_message")
    .map((entry) => (entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>).text);
}

async function fetchSubagentAssistantTexts(
  client: DaemonClient,
  agentId: string,
  subagentId: string,
): Promise<string[]> {
  const timeline = await client.fetchProviderSubagentTimeline(agentId, subagentId, { limit: 50 });
  return timeline.rows
    .filter((row) => row.item.type === "assistant_message")
    .map((row) => (row.item as Extract<AgentTimelineItem, { type: "assistant_message" }>).text);
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
        client.fetchAgents({ subscribe: {} }),
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

  test("a background subagent keeps running after a message is sent while it works", async () => {
    // The scenario the rest of this file explicitly rules out: every other test here tells Claude
    // "Do not use a background task", so steering during a backgrounded subagent was never
    // covered. A subagent streams on the parent's channel, so a parent that mistakes the child's
    // frames for its own work reports "running" after it has already finished, and the message
    // sent into that window is refused, or delivered by cancelling the turn and taking the
    // subagent with it. Both outcomes are user-visible, and both are what this asserts against.
    const logger = pino({ level: "silent" });
    const resources: SteeringResources = {
      cwd: tmpCwd(),
      daemon: null,
      client: null,
      collector: null,
    };
    try {
      resources.daemon = await createTestPaseoDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      resources.client = new DaemonClient({ url: `ws://127.0.0.1:${resources.daemon.port}/ws` });
      const { client, cwd } = resources;
      if (!client) throw new Error("Claude background-subagent test client was not created");
      await within("connect background-subagent test client", 15_000, client.connect());
      await within(
        "subscribe background-subagent test client",
        15_000,
        client.fetchAgents({ subscribe: {} }),
      );
      const agent = await within(
        "create background-subagent test agent",
        30_000,
        client.createAgent({
          cwd: cwd ?? process.cwd(),
          title: "claude-background-survives-send",
          ...getRealProviderConfig("claude"),
        }),
      );
      resources.collector = createMessageCollector(client);
      await within(
        "launch one background subagent and end the turn",
        30_000,
        client.sendAgentMessage(
          agent.id,
          [
            "Use the Agent tool exactly once with run_in_background: true.",
            "subagent_type: general-purpose.",
            `description: "bg survivor".`,
            `prompt: "Use the Bash tool with run_in_background: true to run exactly: sleep 40.`,
            `Wait for its completion notification, then reply exactly: CHILD_DONE."`,
            "Immediately after launching it, reply with the single word LAUNCHED and end your turn.",
            "Do not wait for it. Do not call any other tools.",
          ].join(" "),
          { messageId: generateClientMessageId() },
        ),
      );

      // The main session has ended its turn. It must read as idle even though the subagent it
      // launched is still streaming on the shared channel.
      const afterLaunch = await within(
        "wait for the main session to go idle after launching the subagent",
        120_000,
        client.waitForFinish(agent.id, 110_000),
      );
      expect(
        afterLaunch.status,
        "a main session that finished its turn must not report busy because a subagent is running",
      ).not.toBe("running");

      // And a message sent in that window must be accepted rather than refused.
      const followUpId = generateClientMessageId();
      await within(
        "send a message to the idle main session while the subagent runs",
        30_000,
        client.sendAgentMessage(agent.id, "Are you there? Reply exactly: MAIN_ALIVE.", {
          messageId: followUpId,
        }),
      );
      await within(
        "wait for the main session to answer",
        120_000,
        client.waitForFinish(agent.id, 110_000),
      );

      const timeline = await within(
        "fetch background-subagent timeline",
        15_000,
        client.fetchAgentTimeline(agent.id, { limit: 200 }),
      );
      const assistantText = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map(
          (entry) => (entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>).text,
        )
        .join("\\n");
      expect(
        assistantText,
        "the main session must be reachable while its background subagent still runs",
      ).toContain("MAIN_ALIVE");

      // The subagent must have survived the send rather than being cancelled with the turn. Its
      // status is read from agent.provider_subagents.list (see the note above
      // waitForProviderSubagentToExist): agent_stream carries no provider_subagent events.
      const { subagents } = await within(
        "list provider subagents after the send",
        15_000,
        client.listProviderSubagents(agent.id),
      );
      expect(subagents.length, "the background subagent must be tracked").toBeGreaterThan(0);
      expect(
        subagents.map((subagent) => subagent.status),
        "a backgrounded subagent must not be canceled by a message sent to the main session",
      ).not.toContain("canceled");
      const { subagent, history } = await within(
        "wait for the background subagent to finish",
        90_000,
        waitForProviderSubagentTerminal(client, agent.id, 80_000),
      );
      expect(subagent.status, "the helper must complete, not be canceled or fail").toBe(
        "completed",
      );
      expect(history, "no status poll may read canceled").not.toContain("canceled");
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
      expect(failures, "Claude background-subagent E2E cleanup failures").toEqual([]);
    }
  }, 300_000);

  test("Stop cancels a queued Claude steer before it can resume the interrupted turn", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const collector = createMessageCollector(client);
    try {
      await within("connect queued-steer Stop client", 15_000, client.connect());
      await within(
        "subscribe queued-steer Stop client",
        15_000,
        client.fetchAgents({ subscribe: {} }),
      );
      const agent = await within(
        "create queued-steer Stop agent",
        30_000,
        client.createAgent({
          cwd,
          title: "claude-queued-steer-stop",
          ...getRealProviderConfig("claude"),
        }),
      );
      await within(
        "start original Claude sleep turn",
        30_000,
        client.sendAgentMessage(
          agent.id,
          "Use Bash to run exactly: sleep 5 in the foreground. Do not finish until instructed.",
          { messageId: generateClientMessageId() },
        ),
      );
      await within(
        "wait for original Claude tool boundary",
        90_000,
        waitForRunningClaudeSleep(client, collector, agent.id, 80_000),
      );
      const steerId = generateClientMessageId();
      await within(
        "admit queued Claude steer",
        30_000,
        client.sendAgentMessage(agent.id, "RESUME_FORBIDDEN", {
          messageId: steerId,
          activeTurnBehavior: "steer",
        }),
      );
      const messagesBeforeStop = collector.messages.length;
      await within("Stop original Claude turn", 30_000, client.cancelAgent(agent.id));
      await within("wait for stopped Claude turn", 60_000, client.waitForFinish(agent.id, 50_000));
      const afterStop = collector.messages.slice(messagesBeforeStop);
      expect(
        afterStop.filter(
          (message) =>
            message.type === "agent_stream" &&
            message.payload.agentId === agent.id &&
            message.payload.event.type === "turn_started",
        ),
      ).toHaveLength(0);
      // The steer's row stays in the transcript even though Claude never read it, matching Codex.
      expect(getAssistantTexts(afterStop, agent.id).join("\n")).not.toContain("RESUME_FORBIDDEN");
    } finally {
      const cleanup = await Promise.allSettled([client.close(), daemon.close()]);
      rmSync(cwd, { recursive: true, force: true });
      expect(
        cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ).toEqual([]);
    }
  }, 180_000);

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
      await client.fetchAgents({ subscribe: {} });

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

  test("a helper's own nested background job does not phantom-run the parent or kill the helper", async () => {
    // The exact reported bug: main backgrounds a helper, the helper itself starts its OWN
    // background job (a grandchild from main's perspective) and then keeps working in the
    // foreground. The grandchild's completion is bookkeeping that belongs to the helper, not to
    // main, and must not make main phantom-report "running" or get treated as busy.
    const logger = pino({ level: "silent" });
    const resources: SteeringResources = {
      cwd: tmpCwd(),
      daemon: null,
      client: null,
      collector: null,
    };
    try {
      resources.daemon = await createTestPaseoDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      resources.client = new DaemonClient({ url: `ws://127.0.0.1:${resources.daemon.port}/ws` });
      const { client, cwd } = resources;
      if (!client) throw new Error("nested background-job test client was not created");
      await within("connect nested background-job test client", 15_000, client.connect());
      await within(
        "subscribe nested background-job test client",
        15_000,
        client.fetchAgents({ subscribe: {} }),
      );
      const agent = await within(
        "create nested background-job test agent",
        30_000,
        client.createAgent({
          cwd: cwd ?? process.cwd(),
          title: "claude-nested-background-job",
          ...getRealProviderConfig("claude"),
        }),
      );
      resources.collector = createMessageCollector(client);

      await within(
        "launch a helper with its own nested background job and end the turn",
        30_000,
        client.sendAgentMessage(
          agent.id,
          [
            "Use the Agent tool exactly once with run_in_background: true.",
            "subagent_type: general-purpose.",
            `description: "nested bg survivor".`,
            `prompt: "Use the Bash tool with run_in_background: true to run exactly:`,
            `python3 -c 'import time; time.sleep(5)'.`,
            `Immediately after starting it, without waiting for it, use the Bash tool again`,
            `in the foreground to run exactly: python3 -c 'import time; time.sleep(50)'.`,
            `After that foreground command finishes, reply exactly: CHILD_DONE."`,
            "Immediately after launching it, reply with the single word LAUNCHED and end your turn.",
            "Do not wait for it. Do not call any other tools.",
          ].join(" "),
          { messageId: generateClientMessageId() },
        ),
      );

      const afterLaunch = await within(
        "wait for the main session to go idle after launching the nested-background helper",
        120_000,
        client.waitForFinish(agent.id, 110_000),
      );
      expect(afterLaunch.status, "the main session must be idle once it replied LAUNCHED").toBe(
        "idle",
      );

      // The helper's own nested background job (5s) finishes while the helper is still busy
      // in its unrelated foreground sleep (50s). Sample for 30s, well past the nested job's
      // completion even when the helper is slow to start it,
      // both by polling and by scanning every pushed agent_update in the window, so a brief
      // phantom flip cannot slip between polls.
      const sampleWindowStart = resources.collector.messages.length;
      const polledStatuses = await sampleAgentStatuses(client, agent.id, 11, 3_000);
      const pushedStatuses = getAgentStatuses(
        resources.collector.messages.slice(sampleWindowStart),
        agent.id,
      );
      const observedRunning = [...polledStatuses, ...pushedStatuses].filter(
        (status) => status === "running",
      );
      expect(
        observedRunning,
        `the parent must stay idle across the nested job's completion; polled=${JSON.stringify(polledStatuses)} pushed=${JSON.stringify(pushedStatuses)}`,
      ).toEqual([]);

      // A message sent in that window must still be answered normally.
      await within(
        "send PONG request while the nested job settles",
        30_000,
        client.sendMessage(agent.id, "Reply with exactly PONG.", {
          messageId: generateClientMessageId(),
        }),
      );
      await within("wait for the PONG reply", 60_000, client.waitForFinish(agent.id, 50_000));
      // Pulled via fetchAgentTimeline, not the push collector: assistant text delivery is paced
      // (docs/agent-stream-performance.md) and can trail waitForFinish's own completion signal,
      // so the collector can still be missing the final text the instant waitForFinish resolves.
      const pongTexts = await within(
        "fetch timeline for the PONG reply",
        15_000,
        fetchAssistantTexts(client, agent.id, 20),
      );
      expect(
        pongTexts.join("\n"),
        "the agent must answer PONG while the helper is still running",
      ).toContain("PONG");

      const messagesBeforeWake = resources.collector.messages.length;

      // The helper itself must survive: never recorded canceled, and it eventually reports
      // CHILD_DONE from its own foreground sleep finishing.
      const { subagent, history } = await within(
        "wait for the nested-background helper to finish",
        90_000,
        waitForProviderSubagentTerminal(client, agent.id, 80_000),
      );
      expect(subagent.status, "the helper must complete, not be canceled or fail").toBe(
        "completed",
      );
      expect(
        history,
        `no provider subagent status poll may ever read canceled; history=${JSON.stringify(history)}`,
      ).not.toContain("canceled");
      const subagentTexts = await fetchSubagentAssistantTexts(client, agent.id, subagent.id);
      expect(
        subagentTexts.join("\n"),
        "the helper's own transcript must contain its final CHILD_DONE reply",
      ).toContain("CHILD_DONE");

      // The helper's completion should wake the main session with a fresh turn (the
      // session-state-driven autonomous turn), separate from the PONG exchange above.
      const wokeMainAgent = await waitForWakeTurn(
        resources.collector,
        agent.id,
        messagesBeforeWake,
      );
      if (!wokeMainAgent) {
        const wakeWindowMessages = resources.collector.messages.slice(messagesBeforeWake);
        const wakeWindowEventTypes = wakeWindowMessages
          .filter(
            (message) => message.type === "agent_stream" && message.payload.agentId === agent.id,
          )
          .map((message) =>
            message.type === "agent_stream" ? message.payload.event.type : "unknown",
          );
        const timeline = await client
          .fetchAgentTimeline(agent.id, { limit: 100 })
          .catch(() => null);
        throw new Error(
          `the helper's completion must wake the main session with a new turn. ` +
            `wakeWindowEventTypes=${JSON.stringify(wakeWindowEventTypes)} ` +
            `recentTimeline=${JSON.stringify(timeline ? summarizeTimelineItems(timeline) : null)}`,
        );
      }

      expect(await waitForAgentStatus(client, agent.id, "idle"), "the agent must end idle").toBe(
        "idle",
      );
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
      expect(failures, "nested background-job E2E cleanup failures").toEqual([]);
    }
  }, 300_000);

  test("the app's default steer survives a backgrounded helper while the main session works", async () => {
    // appSettings.sendBehavior defaults to "steer" (packages/app/src/hooks/use-settings/storage.ts),
    // so this is what the app actually sends when a user replies while an agent looks busy.
    const logger = pino({ level: "silent" });
    const resources: SteeringResources = {
      cwd: tmpCwd(),
      daemon: null,
      client: null,
      collector: null,
    };
    try {
      resources.daemon = await createTestPaseoDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      resources.client = new DaemonClient({ url: `ws://127.0.0.1:${resources.daemon.port}/ws` });
      const { client, cwd } = resources;
      if (!client) throw new Error("default-steer background-helper test client was not created");
      await within("connect default-steer test client", 15_000, client.connect());
      await within(
        "subscribe default-steer test client",
        15_000,
        client.fetchAgents({ subscribe: {} }),
      );
      const agent = await within(
        "create default-steer test agent",
        30_000,
        client.createAgent({
          cwd: cwd ?? process.cwd(),
          title: "claude-default-steer-background-helper",
          ...getRealProviderConfig("claude"),
        }),
      );
      resources.collector = createMessageCollector(client);

      await within(
        "launch the background helper and start the main session's own foreground sleep",
        30_000,
        client.sendAgentMessage(
          agent.id,
          [
            "Use the Agent tool exactly once with run_in_background: true.",
            "subagent_type: general-purpose.",
            `description: "bg survivor b".`,
            `prompt: "Use the Bash tool in the foreground to run exactly:`,
            `python3 -c 'import time; time.sleep(42)'. After it finishes, reply exactly: CHILD_DONE."`,
            "Do not wait for that background helper to finish before continuing.",
            "After launching it, use the Bash tool one more time yourself, WITHOUT run_in_background,",
            "to run exactly: python3 -c 'import time; time.sleep(16)'.",
            // Matching the proven pattern from the first test in this file: tell Claude to wait
            // for a later message rather than relying on the sleep call itself to block, since a
            // Bash call can resolve through Claude Code's own async task_notification path once a
            // background subagent is already active instead of blocking the turn.
            "Do not reply or finish your turn until a later user message arrives, no matter how",
            "quickly that Bash command finishes. When that later message arrives, address it and",
            "end your turn. Do not call any other tools.",
          ].join(" "),
          { messageId: generateClientMessageId() },
        ),
      );

      // Confirm the daemon considers main's own turn active before steering it. This does not
      // wait for a specific "sleep 16" shell call to show as running: Claude Code 2.1.280 can
      // report a slower Bash call through its own async task_notification tool instead of a
      // classic blocking call once a background subagent is already active, so pinning to a
      // literal running shell tool_call is not reliable here. Busy at the daemon level is what
      // "while main is busy with its own sleep" actually needs.
      await within(
        "confirm main's own turn is active before steering",
        30_000,
        client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running", 25_000),
      );

      await within(
        "send the app's default steer while main is busy with its own sleep",
        30_000,
        client.sendMessage(agent.id, "Reply with exactly PONG.", {
          messageId: generateClientMessageId(),
          activeTurnBehavior: "steer",
        }),
      );

      const finish = await within(
        "wait for the main session to finish after the steer",
        120_000,
        client.waitForFinish(agent.id, 110_000),
      );
      expect(finish.status, "the main session must end idle after the steer").toBe("idle");
      // Pulled via fetchAgentTimeline, not the push collector: see fetchAssistantTexts.
      const postSteerTexts = await within(
        "fetch timeline for the post-steer PONG reply",
        15_000,
        fetchAssistantTexts(client, agent.id, 20),
      );
      expect(postSteerTexts.join("\n"), "PONG must be answered after the steer").toContain("PONG");

      const { subagent, history } = await within(
        "wait for the background helper to finish",
        90_000,
        waitForProviderSubagentTerminal(client, agent.id, 80_000),
      );
      expect(subagent.status, "the helper must complete, not be canceled or fail").toBe(
        "completed",
      );
      expect(
        history,
        `no provider subagent status poll may ever read canceled; history=${JSON.stringify(history)}`,
      ).not.toContain("canceled");
      const subagentTexts = await fetchSubagentAssistantTexts(client, agent.id, subagent.id);
      expect(
        subagentTexts.join("\n"),
        "the helper's own transcript must contain its final CHILD_DONE reply",
      ).toContain("CHILD_DONE");
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
      expect(failures, "default-steer background-helper E2E cleanup failures").toEqual([]);
    }
  }, 300_000);

  test("Stop cancels the main session's own turn but spares its background helper", async () => {
    const logger = pino({ level: "silent" });
    const resources: SteeringResources = {
      cwd: tmpCwd(),
      daemon: null,
      client: null,
      collector: null,
    };
    try {
      resources.daemon = await createTestPaseoDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      resources.client = new DaemonClient({ url: `ws://127.0.0.1:${resources.daemon.port}/ws` });
      const { client, cwd } = resources;
      if (!client) throw new Error("Stop-spares-helper test client was not created");
      await within("connect Stop-spares-helper test client", 15_000, client.connect());
      await within(
        "subscribe Stop-spares-helper test client",
        15_000,
        client.fetchAgents({ subscribe: {} }),
      );
      const agent = await within(
        "create Stop-spares-helper test agent",
        30_000,
        client.createAgent({
          cwd: cwd ?? process.cwd(),
          title: "claude-stop-spares-helper",
          ...getRealProviderConfig("claude"),
        }),
      );
      resources.collector = createMessageCollector(client);

      await within(
        "launch the background helper and start the main session's own foreground sleep",
        30_000,
        client.sendAgentMessage(
          agent.id,
          [
            "Use the Agent tool exactly once with run_in_background: true.",
            "subagent_type: general-purpose.",
            `description: "bg survivor c".`,
            `prompt: "Use the Bash tool in the foreground to run exactly:`,
            `python3 -c 'import time; time.sleep(43)'. After it finishes, reply exactly: CHILD_DONE."`,
            "Do not wait for that background helper to finish before continuing.",
            "After launching it, use the Bash tool one more time yourself, WITHOUT run_in_background,",
            "to run exactly: python3 -c 'import time; time.sleep(23)'.",
            "Do not call any other tools.",
          ].join(" "),
          { messageId: generateClientMessageId() },
        ),
      );

      // Confirm the helper has actually been launched (registered) before Stop, not just that
      // main's turn shows "running": that status can flip true on generic turn-start bookkeeping
      // before Claude has issued the Agent tool call, and canceling that early cancels a turn
      // with no helper to spare yet.
      await within(
        "confirm the background helper is registered before Stop",
        60_000,
        waitForProviderSubagentToExist(client, agent.id, 55_000),
      );

      const messagesBeforeStop = resources.collector.messages.length;
      await within("Stop the main session's own turn", 30_000, client.cancelAgent(agent.id));
      const afterStop = await within(
        "wait for the agent to go idle after Stop",
        60_000,
        client.waitForFinish(agent.id, 50_000),
      );
      expect(afterStop.status, "Stop must leave the agent idle").toBe("idle");

      // The helper must survive Stop: it keeps running and later reports CHILD_DONE, which
      // wakes the main session with a fresh autonomous turn.
      const { subagent, history } = await within(
        "wait for the background helper to finish after Stop",
        90_000,
        waitForProviderSubagentTerminal(client, agent.id, 80_000),
      );
      expect(subagent.status, "Stop must not cancel or fail the background helper").toBe(
        "completed",
      );
      expect(
        history,
        `no provider subagent status poll may ever read canceled; history=${JSON.stringify(history)}`,
      ).not.toContain("canceled");
      const subagentTexts = await fetchSubagentAssistantTexts(client, agent.id, subagent.id);
      expect(
        subagentTexts.join("\n"),
        "the helper's own transcript must contain its final CHILD_DONE reply",
      ).toContain("CHILD_DONE");

      const wokeMainAgent = await waitForWakeTurn(
        resources.collector,
        agent.id,
        messagesBeforeStop,
      );
      expect(
        wokeMainAgent,
        "the helper's completion after Stop must wake the main session with a new turn",
      ).toBe(true);

      expect(await waitForAgentStatus(client, agent.id, "idle"), "the agent must end idle").toBe(
        "idle",
      );
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
      expect(failures, "Stop-spares-helper E2E cleanup failures").toEqual([]);
    }
  }, 300_000);
});
