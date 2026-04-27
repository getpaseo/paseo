import { query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentLaunchContext } from "../agent-sdk-types.js";
import { ClaudeAgentClient } from "./claude-agent.js";

function createQueryMock(events: unknown[]): Query {
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
  } as Query;
}

function stubRuntimeControlEnv(): void {
  vi.stubEnv("CLAUDECODE", "1");
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  vi.stubEnv("ELECTRON_NO_ATTACH_CONSOLE", "1");
  vi.stubEnv("PASEO_DESKTOP_MANAGED", "1");
  vi.stubEnv("PASEO_NODE_ENV", "production");
  vi.stubEnv("PASEO_SUPERVISED", "1");
}

function expectRuntimeControlEnvScrubbed(env: Options["env"] | undefined): void {
  expect(env?.CLAUDECODE).toBeUndefined();
  expect(env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(env?.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
  expect(env?.PASEO_DESKTOP_MANAGED).toBeUndefined();
  expect(env?.PASEO_NODE_ENV).toBeUndefined();
  expect(env?.PASEO_SUPERVISED).toBeUndefined();
}

describe("Claude SDK env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("forwards launch-context env through Claude process env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000201",
        PASEO_TEST_FLAG: "launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: Parameters<typeof query>[0]) => {
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
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
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
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
    } finally {
      await session.close();
    }
  });

  test("forwards launch-context env through Claude resume env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000202",
        PASEO_TEST_FLAG: "resume-launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: Parameters<typeof query>[0]) => {
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
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
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
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
    } finally {
      await session.close();
    }
  });

  test("uses provider env boundary while preserving explicit and launch env values", async () => {
    stubRuntimeControlEnv();

    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: Parameters<typeof query>[0]) => {
      capturedOptions = options;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "claude-sdk-env-session",
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
    });
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      runtimeSettings: {
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          PASEO_NODE_ENV: "runtime",
          RUNTIME_ENV: "yes",
        },
      },
    });
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
        extra: {
          claude: {
            env: {
              ELECTRON_NO_ATTACH_CONSOLE: "1",
              EXTRA_ENV: "extra",
            },
          },
        },
      },
      {
        env: {
          PASEO_AGENT_ID: "agent-123",
          PASEO_SUPERVISED: "1",
        },
      },
    );

    try {
      await session.run("sdk env boundary regression");
    } finally {
      await session.close();
    }

    expect(capturedOptions?.env?.MCP_TIMEOUT).toBe("600000");
    expect(capturedOptions?.env?.MCP_TOOL_TIMEOUT).toBe("600000");
    expect(capturedOptions?.env?.PASEO_AGENT_ID).toBe("agent-123");
    expect(capturedOptions?.env?.RUNTIME_ENV).toBe("yes");
    expect(capturedOptions?.env?.EXTRA_ENV).toBe("extra");
    expectRuntimeControlEnvScrubbed(capturedOptions?.env);
  });
});
