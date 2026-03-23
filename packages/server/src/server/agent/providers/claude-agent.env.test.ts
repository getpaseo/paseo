import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./claude-agent.js";
import { attachManagedAgentId } from "../session-config-internals.js";

function createQueryMock(events: unknown[]) {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

describe("Claude agent env", () => {
  test("passes the managed Paseo agent id through Claude process env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(
      ({ options }: { options: { env?: Record<string, string | undefined> } }) => {
        capturedEnv = options.env;
        return createQueryMock([
          {
            type: "system",
            subtype: "init",
            session_id: "managed-agent-env-session",
            permissionMode: "default",
            model: "opus",
          },
          {
            type: "assistant",
            message: { content: "done" },
          },
          {
            type: "result",
            subtype: "success",
            usage: {
              input_tokens: 1,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
            total_cost_usd: 0,
          },
        ]);
      },
    );

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: queryFactory as never,
    });
    const session = await client.createSession(
      attachManagedAgentId(
        {
          provider: "claude",
          cwd: process.cwd(),
        },
        "00000000-0000-4000-8000-000000000201",
      ),
    );

    try {
      const result = await session.run("env check");
      expect(result.sessionId).toBe("managed-agent-env-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe("00000000-0000-4000-8000-000000000201");
    } finally {
      await session.close();
    }
  });
});
