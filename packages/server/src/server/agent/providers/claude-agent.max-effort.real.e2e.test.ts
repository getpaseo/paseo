import { describe, expect, test } from "vitest";
import pino from "pino";

import type { AgentStreamEvent, AgentSession } from "../agent-sdk-types.js";
import { isCommandAvailable } from "../../../utils/executable.js";
import { ClaudeAgentClient } from "./claude-agent.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";

const hasClaudeCredentials =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

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
  test.runIf(isCommandAvailable("claude") && hasClaudeCredentials)(
    "surfaces the Claude stderr diagnostic when bypassPermissions + max effort is unavailable",
    async () => {
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
    },
    30_000,
  );
});
