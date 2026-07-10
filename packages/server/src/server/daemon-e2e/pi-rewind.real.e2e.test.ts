import { readdir } from "node:fs/promises";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { canRunRealProvider, createRealProviderClients } from "./real-provider-test-config.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  tmpRewindCwd,
  userMessageIdForToken,
} from "./test-utils/rewind-helpers.js";

interface PiRewindHarness {
  client: DaemonClient;
  daemon: TestPaseoDaemon;
}

interface PiRewindSession {
  agentId: string;
  cwd: string;
}

const TURN_TIMEOUT_MS = 240_000;
const PI_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";

async function launchPiRewindSession(
  harness: PiRewindHarness,
  title: string,
): Promise<PiRewindSession> {
  const cwd = tmpRewindCwd("daemon-real-pi-rewind-");
  const agent = await harness.client.createAgent({
    cwd,
    title,
    provider: "pi",
    model: PI_REAL_TEST_MODEL,
    thinkingOptionId: "medium",
  });

  return { agentId: agent.id, cwd };
}

async function closePiRewindSession(session: PiRewindSession): Promise<void> {
  closeRewindSession(session);
}

async function runtimeSessionId(
  harness: PiRewindHarness,
  session: PiRewindSession,
): Promise<string> {
  const snapshot = await harness.client.fetchAgent({ agentId: session.agentId });
  const sessionId =
    snapshot?.agent.runtimeInfo?.sessionId ?? snapshot?.agent.persistence?.sessionId;
  if (!sessionId) {
    throw new Error(`Agent ${session.agentId} does not have a visible Pi session id`);
  }
  return sessionId;
}

function expectPiSessionId(value: string): void {
  expect(value.length).toBeGreaterThan(0);
}

function piPrompt(input: { promptToken: string; doneToken: string }): string {
  return [
    `PASEO_PI_REWIND_PROMPT_${input.promptToken}.`,
    "Remember this marker for the conversation.",
    `Reply exactly: ${input.doneToken}`,
  ].join(" ");
}

function roleItems(items: AgentTimelineItem[], role: "user_message" | "assistant_message") {
  return items.filter((item) => item.type === role);
}

function expectTimeline(
  items: AgentTimelineItem[],
  input: { userTexts: string[]; assistantCount: number },
): void {
  const userMessages = roleItems(items, "user_message");
  const assistantMessages = roleItems(items, "assistant_message");

  expect(userMessages).toHaveLength(input.userTexts.length);
  expect(userMessages.map((message) => message.text)).toEqual(input.userTexts);
  expect(assistantMessages).toHaveLength(input.assistantCount);
}

async function expectNoCreatedFiles(session: PiRewindSession): Promise<void> {
  await expect(readdir(session.cwd)).resolves.toEqual([]);
}

async function askPi(
  harness: PiRewindHarness,
  session: PiRewindSession,
  input: { promptToken: string; doneToken: string },
): Promise<void> {
  await harness.client.sendMessage(session.agentId, piPrompt(input));
  const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
}

describe("daemon E2E (real pi) - rewind", () => {
  let canRun = false;
  let harness: PiRewindHarness;

  beforeAll(async () => {
    canRun = await canRunRealProvider("pi");
    if (!canRun) {
      return;
    }
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["pi"], logger),
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });

    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "pi-rewind-real" } });
    harness = { client, daemon };
  }, 30_000);

  afterAll(async () => {
    await harness?.client.close().catch(() => undefined);
    await harness?.daemon.close().catch(() => undefined);
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("rewinds a real Pi conversation after a single turn and keeps the session usable", async () => {
    if (!harness) throw new Error("Pi rewind harness was not initialized");
    const session = await launchPiRewindSession(harness, "pi-rewind-single-conversation-real");

    try {
      await askPi(harness, session, {
        promptToken: "SINGLE",
        doneToken: "PI_SINGLE_DONE",
      });
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const firstMessageId = userMessageIdForToken(firstTimeline, "PI_REWIND_PROMPT_SINGLE");
      const sessionIdBefore = await runtimeSessionId(harness, session);
      expectPiSessionId(sessionIdBefore);

      await harness.client.rewindAgent(session.agentId, firstMessageId, "conversation");
      const sessionIdAfter = await runtimeSessionId(harness, session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(sessionIdAfter).toBe(sessionIdBefore);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
      await expectNoCreatedFiles(session);

      await askPi(harness, session, {
        promptToken: "AFTER_SINGLE",
        doneToken: "PI_AFTER_SINGLE_DONE",
      });
      const nextTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expectTimeline(nextTimeline, {
        userTexts: [piPrompt({ promptToken: "AFTER_SINGLE", doneToken: "PI_AFTER_SINGLE_DONE" })],
        assistantCount: 1,
      });
      await expectNoCreatedFiles(session);
    } finally {
      await closePiRewindSession(session);
    }
  }, 420_000);

  test("rewinds a real Pi conversation to an earlier user message", async () => {
    const session = await launchPiRewindSession(harness, "pi-rewind-conversation-real");

    try {
      await askPi(harness, session, {
        promptToken: "FIRST",
        doneToken: "PI_FIRST_DONE",
      });
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const firstMessageId = userMessageIdForToken(firstTimeline, "PI_REWIND_PROMPT_FIRST");

      await askPi(harness, session, {
        promptToken: "SECOND",
        doneToken: "PI_SECOND_DONE",
      });
      const sessionIdBefore = await runtimeSessionId(harness, session);
      expectPiSessionId(sessionIdBefore);

      await harness.client.rewindAgent(session.agentId, firstMessageId, "conversation");
      const sessionIdAfter = await runtimeSessionId(harness, session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(sessionIdAfter).toBe(sessionIdBefore);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
      await expectNoCreatedFiles(session);
    } finally {
      await closePiRewindSession(session);
    }
  }, 420_000);
});
