import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import type { AgentStreamEvent, AgentSession } from "../../agent-sdk-types.js";
import { isProviderAvailable } from "../../../daemon-e2e/agent-configs.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";

function isTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

async function collectUntilTerminal(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamSession(session, "Respond with exactly: HELLO_MAX")) {
    events.push(event);
    if (isTerminalEvent(event)) {
      return events;
    }
  }
  return events;
}

describe("Claude max effort availability (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("surfaces the Claude stderr diagnostic when bypassPermissions + max effort is unavailable", async () => {
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      modeId: "bypassPermissions",
      model: "claude-opus-4-6",
      thinkingOptionId: "max",
    });

    try {
      const events = await collectUntilTerminal(session);
      const failure = events.find(
        (event): event is Extract<AgentStreamEvent, { type: "turn_failed" }> =>
          event.type === "turn_failed",
      );

      expect(failure).toBeDefined();
      expect(failure?.error).toContain("Claude Code process exited with code 1");
      expect(failure?.code).toBe("1");
      expect(failure?.diagnostic).toContain('Effort level "max" is not available');
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 30_000);
});
