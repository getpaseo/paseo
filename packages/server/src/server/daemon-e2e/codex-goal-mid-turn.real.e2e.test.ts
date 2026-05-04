import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { resolveBinaryVersion } from "../agent/providers/diagnostic-utils.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig, isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-codex-goal-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateClientMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// /goal lives behind codex's `--enable goals` feature flag, which only exists
// on codex-cli >= 0.128.0. Older binaries hard-fail at launch when given the
// flag, so the codex provider gates registration on the version probe and
// older boxes never see the command. Tests must mirror that gate.
const GOAL_MIN_VERSION: readonly [number, number, number] = [0, 128, 0];

function parseVersion(versionOutput: string): [number, number, number] | null {
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function meetsMinVersion(versionOutput: string, min: readonly [number, number, number]): boolean {
  const parsed = parseVersion(versionOutput);
  if (!parsed) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] > min[i]) return true;
    if (parsed[i] < min[i]) return false;
  }
  return true;
}

async function waitForAssistantWaitingOnSleep(
  client: DaemonClient,
  agentId: string,
  timeoutMs = 75_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 });
    const assistantText = timeline.entries
      .filter((entry) => entry.item.type === "assistant_message")
      .map((entry) => (entry.item as { text: string }).text)
      .join("\n");
    if (/sleep|waiting|running/i.test(assistantText) && !/\bdone\b/.test(assistantText)) {
      return;
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for codex to enter the sleep tool call");
}

async function waitForAssistantText(
  client: DaemonClient,
  agentId: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const timeline = await client.fetchAgentTimeline(agentId, { limit: 200 });
    const assistantTexts = timeline.entries
      .filter((entry) => entry.item.type === "assistant_message")
      .map((entry) => (entry.item as { text: string }).text);
    if (assistantTexts.some(predicate)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("daemon E2E (real codex) - /goal command", () => {
  let canRun = false;

  beforeAll(async () => {
    if (!(await isProviderAvailable("codex"))) {
      return;
    }
    const versionOutput = await resolveBinaryVersion("codex");
    canRun = meetsMinVersion(versionOutput, GOAL_MIN_VERSION);
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("/goal <objective> sets the goal and the model can read it back", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: new CodexAppServerAgentClient(logger) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "primary" } });

      const agent = await client.createAgent({
        cwd,
        title: "codex-goal-set",
        ...getFullAccessConfig("codex"),
      });

      const sentinel = "TX9Q4Z";
      await client.sendMessage(agent.id, `/goal ship feature ${sentinel}`);
      // Out-of-band commands don't drive the agent through running→idle, so
      // wait on the ack text directly instead of waitForFinish.
      await waitForAssistantText(
        client,
        agent.id,
        (text) => text.startsWith("Goal set: ship feature " + sentinel),
        30_000,
        "/goal set acknowledgement",
      );

      // Model awareness check: ask what the goal is. Per the user-visible
      // behavior the codex experiment promises, the model should reference
      // the objective in its response.
      await client.sendMessage(
        agent.id,
        "What is your current goal? Reply with just the objective text, nothing else.",
      );
      const askResult = await client.waitForFinish(agent.id, 120_000);
      expect(askResult.status).toBe("idle");

      const finalTimeline = await client.fetchAgentTimeline(agent.id, { limit: 200 });
      const finalAssistantTexts = finalTimeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => (entry.item as { text: string }).text);
      const lastModelReply = finalAssistantTexts[finalAssistantTexts.length - 1] ?? "";
      expect(lastModelReply.includes(sentinel)).toBe(true);
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  test("/goal pause mid-turn does not cancel the running turn", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: new CodexAppServerAgentClient(logger) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "primary" } });

      const agent = await client.createAgent({
        cwd,
        title: "codex-goal-mid-turn",
        ...getFullAccessConfig("codex"),
      });

      // Set an initial goal so pause has something to act on.
      await client.sendMessage(agent.id, "/goal pilot the long-turn flow");
      await waitForAssistantText(
        client,
        agent.id,
        (text) => text.startsWith("Goal set: pilot the long-turn flow"),
        30_000,
        "/goal set acknowledgement",
      );

      // Kick off a long-running tool call. We must NOT await this turn.
      await client.sendAgentMessage(
        agent.id,
        "Use the shell tool to run exactly: sleep 30 && echo done. Then report what it outputs. Be brief.",
        { messageId: generateClientMessageId() },
      );
      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
        60_000,
      );
      await waitForAssistantWaitingOnSleep(client, agent.id);

      // Mid-turn: send /goal pause. This must not cancel the running turn.
      await client.sendAgentMessage(agent.id, "/goal pause", {
        messageId: generateClientMessageId(),
      });

      // The running turn must still finish naturally with the sleep output.
      const finishResult = await client.waitForFinish(agent.id, 180_000);
      expect(finishResult.status).toBe("idle");

      // Use canonical projection so each timeline row stays as-is. The default
      // `projected` view merges contiguous assistant_message rows (a streaming
      // optimization), which would coalesce the out-of-band ack with codex's
      // next streamed delta. Canonical view sees the underlying raw rows.
      const timeline = await client.fetchAgentTimeline(agent.id, {
        limit: 200,
        projection: "canonical",
      });
      const assistantTexts = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => (entry.item as { text: string }).text);

      // Pause acknowledgement must be present as its own row (out-of-band).
      expect(assistantTexts.some((text) => text === "Goal paused.")).toBe(true);
      // Original turn must have completed and reported sleep's output.
      expect(assistantTexts.some((text) => /\bdone\b/.test(text))).toBe(true);
      // No system-level error fallback.
      expect(assistantTexts.some((text) => text.startsWith("[Error]"))).toBe(false);
      expect(assistantTexts.some((text) => text.includes("Failed to update goal"))).toBe(false);
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 360_000);

  test("/goal clear removes the goal", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: new CodexAppServerAgentClient(logger) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "primary" } });

      const agent = await client.createAgent({
        cwd,
        title: "codex-goal-clear",
        ...getFullAccessConfig("codex"),
      });

      await client.sendMessage(agent.id, "/goal something to be cleared");
      await waitForAssistantText(
        client,
        agent.id,
        (text) => text.startsWith("Goal set: something to be cleared"),
        30_000,
        "/goal set acknowledgement",
      );

      await client.sendMessage(agent.id, "/goal clear");
      await waitForAssistantText(
        client,
        agent.id,
        (text) => text === "Goal cleared.",
        30_000,
        "/goal clear acknowledgement",
      );
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
