import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentLaunchContext } from "../agent-sdk-types.js";
import { ClaudeAgentClient } from "./claude-agent.js";

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
    const launchContext: AgentLaunchContext = {
      managedAgentId: "00000000-0000-4000-8000-000000000201",
    };
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
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const result = await session.run("env check");
      expect(result.sessionId).toBe("managed-agent-env-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.managedAgentId);
    } finally {
      await session.close();
    }
  });

  test("passes the managed Paseo agent id through Claude resume env via launch context", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      managedAgentId: "00000000-0000-4000-8000-000000000202",
    };
    const queryFactory = vi.fn(
      ({ options }: { options: { env?: Record<string, string | undefined> } }) => {
        capturedEnv = options.env;
        return createQueryMock([
          {
            type: "system",
            subtype: "init",
            session_id: "persisted-session",
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
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "persisted-session",
        metadata: {
          cwd: process.cwd(),
        },
      },
      {
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const result = await session.run("resume env check");
      expect(result.sessionId).toBe("persisted-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.managedAgentId);
    } finally {
      await session.close();
    }
  });
});
