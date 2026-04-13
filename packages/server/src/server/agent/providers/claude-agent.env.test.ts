import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentLaunchContext } from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
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
  test("forwards launch-context env through Claude process env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000201",
        PASEO_TEST_FLAG: "launch-value",
      },
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
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
    } finally {
      await session.close();
    }
  });

  test("translates model via modelMap in options", async () => {
    let capturedModel: string | undefined;
    const runtimeSettings: ProviderRuntimeSettings = {
      modelMap: {
        "claude-opus-4-6": "qwen3.6-plus",
        "claude-sonnet-4-6": "qwen3.5-plus",
      },
    };
    const queryFactory = vi.fn(
      ({ options }: { options: { model?: string } }) => {
        capturedModel = options.model;
        return createQueryMock([
          {
            type: "system",
            subtype: "init",
            session_id: "modelmap-session",
            permissionMode: "default",
            model: "qwen3.6-plus",
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
      runtimeSettings,
      queryFactory: queryFactory as never,
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-4-6",
    });

    try {
      await session.run("modelmap check");
      expect(capturedModel).toBe("qwen3.6-plus");
    } finally {
      await session.close();
    }
  });

  test("passes model as-is when no modelMap is configured", async () => {
    let capturedModel: string | undefined;
    const queryFactory = vi.fn(
      ({ options }: { options: { model?: string } }) => {
        capturedModel = options.model;
        return createQueryMock([
          {
            type: "system",
            subtype: "init",
            session_id: "no-modelmap-session",
            permissionMode: "default",
            model: "claude-opus-4-6",
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
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-4-6",
    });

    try {
      await session.run("no modelmap check");
      expect(capturedModel).toBe("claude-opus-4-6");
    } finally {
      await session.close();
    }
  });

  test("translates model via modelMap in setModel", async () => {
    const runtimeSettings: ProviderRuntimeSettings = {
      modelMap: {
        "claude-opus-4-6": "qwen3.6-plus",
        "claude-sonnet-4-6": "qwen3.5-plus",
      },
    };
    let setModelArg: string | undefined;
    const queryFactory = vi.fn(() => {
      const mock = createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "setmodel-map-session",
          permissionMode: "default",
          model: "qwen3.6-plus",
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
      mock.setModel = vi.fn(async (m?: string) => { setModelArg = m; });
      return mock;
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings,
      queryFactory: queryFactory as never,
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-4-6",
    });

    try {
      await session.run("setup session");
      await session.setModel!("claude-sonnet-4-6");
      expect(setModelArg).toBe("qwen3.5-plus");
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("claude-sonnet-4-6");
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
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
    } finally {
      await session.close();
    }
  });
});
