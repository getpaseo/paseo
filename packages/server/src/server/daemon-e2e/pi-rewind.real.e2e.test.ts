import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  textByRole,
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

async function askPi(
  harness: PiRewindHarness,
  session: PiRewindSession,
  input: { promptToken: string; doneToken: string },
): Promise<void> {
  await harness.client.sendMessage(
    session.agentId,
    [
      `PASEO_PI_REWIND_PROMPT_${input.promptToken}.`,
      "Remember this marker for the conversation.",
      `Reply exactly: ${input.doneToken}`,
    ].join(" "),
  );
  const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
}

describe("daemon E2E (real pi) - rewind", () => {
  let harness: PiRewindHarness;

  beforeAll(async () => {
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: { pi: new PiRpcAgentClient({ logger }) },
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

  test("rewinds a real Pi conversation after a single turn and keeps the session usable", async () => {
    const session = await launchPiRewindSession(harness, "pi-rewind-single-conversation-real");

    try {
      await askPi(harness, session, {
        promptToken: "SINGLE",
        doneToken: "PI_SINGLE_DONE",
      });
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const firstMessageId = userMessageIdForToken(firstTimeline, "PI_REWIND_PROMPT_SINGLE");

      await harness.client.rewindAgent(session.agentId, firstMessageId, "conversation");
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(textByRole(rewoundTimeline, "user_message")).not.toContain("PI_REWIND_PROMPT_SINGLE");
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain("PI_SINGLE_DONE");

      await askPi(harness, session, {
        promptToken: "AFTER_SINGLE",
        doneToken: "PI_AFTER_SINGLE_DONE",
      });
      const nextTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(textByRole(nextTimeline, "user_message")).toContain("PI_REWIND_PROMPT_AFTER_SINGLE");
      expect(textByRole(nextTimeline, "assistant_message")).toContain("PI_AFTER_SINGLE_DONE");
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

      await harness.client.rewindAgent(session.agentId, firstMessageId, "conversation");
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(textByRole(rewoundTimeline, "user_message")).not.toContain("PI_REWIND_PROMPT_FIRST");
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain("PI_FIRST_DONE");
      expect(textByRole(rewoundTimeline, "user_message")).not.toContain("PI_REWIND_PROMPT_SECOND");
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain("PI_SECOND_DONE");
    } finally {
      await closePiRewindSession(session);
    }
  }, 420_000);
});
