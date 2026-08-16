import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { SessionOutboundMessage } from "../messages.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";

const PI_REAL_TEST_MODEL = getRealProviderConfig("pi").model;

// Pi keeps its agent home (auth, settings lock, session dirs) under the agent
// dir. Point it at a writable temp dir so the test never touches ~/.pi and can
// run in sandboxed environments where the real home is read-only.
const piAgentDir = mkdtempSync(path.join(tmpdir(), "pi-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = piAgentDir;

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-pi-tool-steer-"));
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
}

function getRunningPiSleep(
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

async function waitForRunningPiSleep(
  client: DaemonClient,
  collector: ReturnType<typeof createMessageCollector>,
  agentId: string,
  timeoutMs = 90_000,
  command = /\bsleep 5\b/,
): Promise<ObservedForegroundSleep> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = collector.messages
      .map((message) => getRunningPiSleep(message, agentId, command))
      .find((event): event is ObservedForegroundSleep => event !== null);
    if (observed) {
      return observed;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for Pi to report it was waiting on sleep`);
}

describe("daemon E2E (real pi) - send message during tool call", () => {
  let canRun = false;
  interface SteeringResources {
    cwd: string | null;
    daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | null;
    client: DaemonClient | null;
    collector: ReturnType<typeof createMessageCollector> | null;
  }

  beforeAll(async () => {
    canRun = await canRunRealProvider("pi");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("steers one active Pi turn without starting another", async () => {
    const logger = pino({ level: "silent" });
    const resources: SteeringResources = {
      cwd: tmpCwd(),
      daemon: null,
      client: null,
      collector: null,
    };
    try {
      resources.daemon = await createTestPaseoDaemon({
        agentClients: createRealProviderClients(["pi"], logger),
        logger,
      });
      resources.client = new DaemonClient({ url: `ws://127.0.0.1:${resources.daemon.port}/ws` });
      const { client, cwd } = resources;
      if (!client) throw new Error("Pi steering test client was not created");
      await within("connect steering test client", 15_000, client.connect());
      await within(
        "subscribe steering test client",
        15_000,
        client.fetchAgents({ subscribe: { subscriptionId: "steer" } }),
      );
      const agent = await within(
        "create Pi steering test agent",
        30_000,
        client.createAgent({
          cwd: cwd ?? process.cwd(),
          title: "pi-exact-turn-steer",
          provider: "pi",
          model: PI_REAL_TEST_MODEL,
          thinkingOptionId: "low",
        }),
      );
      resources.collector = createMessageCollector(client);
      await within(
        "submit Pi foreground sleep turn",
        30_000,
        client.sendAgentMessage(
          agent.id,
          "Use the bash tool to run exactly: sleep 5. Run it in the foreground. Do not finish until a later user message arrives; after it arrives, reply exactly: STEERED_SAME_TURN.",
          { messageId: generateClientMessageId() },
        ),
      );
      const foregroundSleep = await within(
        "wait for live Pi foreground sleep tool",
        90_000,
        waitForRunningPiSleep(client, resources.collector, agent.id),
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
        "submit Pi active-turn steer",
        30_000,
        client.sendAgentMessage(agent.id, "hello", {
          messageId: steeringMessageId,
          activeTurnBehavior: "steer",
        }),
      );
      const finish = await within(
        "wait for steered Pi turn to finish",
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
        "fetch steered Pi timeline",
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
      expect(failures, "Pi steering E2E cleanup failures").toEqual([]);
    }
  }, 210_000);
});
