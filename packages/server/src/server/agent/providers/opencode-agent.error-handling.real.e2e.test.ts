import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { isCommandAvailable } from "../../../utils/executable.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";

function isTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

/**
 * Real e2e tests for OpenCode error handling.
 *
 * Validates that OpenCode surfaces errors properly instead of hanging forever
 * when models are invalid, auth fails, or provider API calls fail.
 */
describe("opencode agent error handling (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isCommandAvailable("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("surfaces error for the exact opencode/<bad-model> path used by paseo run", async () => {
    const client = new OpenCodeAgentClient(pino({ level: "silent" }));
    const session = await client.createSession({
      provider: "opencode",
      cwd: process.cwd(),
      modeId: "build",
    });

    try {
      await session.setModel("opencode/adklasldkdas");

      const events: AgentStreamEvent[] = [];
      for await (const event of streamSession(session, "hello")) {
        events.push(event);
        if (isTerminalEvent(event)) break;
      }

      const terminal = events.find(isTerminalEvent);
      expect(terminal).toBeDefined();
      expect(terminal!.type).toBe("turn_failed");
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 45_000);

  test("surfaces error for unknown provider model (fast path)", async () => {
    const client = new OpenCodeAgentClient(pino({ level: "silent" }));
    const session = await client.createSession({
      provider: "opencode",
      cwd: process.cwd(),
      modeId: "build",
    });

    try {
      await session.setModel("bogus-provider/totally-fake-model-12345");

      const events: AgentStreamEvent[] = [];
      for await (const event of streamSession(session, "Say hello")) {
        events.push(event);
        if (isTerminalEvent(event)) break;
      }

      const terminal = events.find(isTerminalEvent);
      expect(terminal).toBeDefined();
      expect(terminal!.type).toBe("turn_failed");
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 30_000);

  test("sequential sessions: second session works after first errors", async () => {
    const client = new OpenCodeAgentClient(pino({ level: "silent" }));

    // Session 1: bogus model, will error quickly
    const s1 = await client.createSession({
      provider: "opencode",
      cwd: process.cwd(),
      modeId: "build",
    });
    await s1.setModel("bogus-provider/fake-model-12345");
    for await (const event of streamSession(s1, "Say hello")) {
      if (isTerminalEvent(event)) break;
    }
    await s1.close();

    // Session 2: different bogus model, should also work
    const s2 = await client.createSession({
      provider: "opencode",
      cwd: process.cwd(),
      modeId: "build",
    });
    await s2.setModel("bogus-provider/fake-model-67890");

    const events: AgentStreamEvent[] = [];
    for await (const event of streamSession(s2, "Say hello")) {
      events.push(event);
      if (isTerminalEvent(event)) break;
    }
    await s2.close().catch(() => undefined);

    const terminal = events.find(isTerminalEvent);
    expect(terminal).toBeDefined();
    expect(terminal!.type).toBe("turn_failed");
  }, 30_000);

  test("surfaces error for known provider with nonexistent model (retry path)", async () => {
    // When the provider is recognized (anthropic) but the model doesn't exist,
    // OpenCode retries before surfacing the error. This must not hang.
    const client = new OpenCodeAgentClient(pino({ level: "silent" }));
    const session = await client.createSession({
      provider: "opencode",
      cwd: process.cwd(),
      modeId: "build",
    });

    try {
      await session.setModel("anthropic/claude-nonexistent-99");

      const events: AgentStreamEvent[] = [];
      const start = Date.now();
      for await (const event of streamSession(session, "Say hello")) {
        events.push(event);
        if (isTerminalEvent(event)) break;
      }
      const elapsed = Date.now() - start;

      const terminal = events.find(isTerminalEvent);
      expect(terminal).toBeDefined();
      expect(elapsed).toBeLessThan(30_000);
      console.log(`[nonexistent model] elapsed=${elapsed}ms terminal=${terminal!.type}`);
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 45_000);

  // Note: there used to be a real-API test here pinned to zai/glm-5.1's
  // "insufficient balance" retry. It's been removed because retry behavior is
  // entirely upstream-dependent — opencode itself decides when to retry, and
  // OpenCode Zen's quota/availability changes over time. The translation logic
  // (session.status:retry → timeline error item) is covered by unit tests in
  // opencode/event-translator.test.ts.
});
