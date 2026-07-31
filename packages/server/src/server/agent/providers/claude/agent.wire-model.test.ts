import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

/**
 * The catalog advertises a 1M context window for the single `claude-opus-5` entry, but
 * Claude Code only opens that window when the model string carries the `[1m]` suffix.
 * resolveClaudeWireModelId is unit-tested on its own; these tests pin the two places the
 * resolved ID actually reaches the SDK, so dropping either call is a test failure rather
 * than a silent return to compacting at 200K.
 */

function createQueryMock(setModel: Query["setModel"]): Query {
  const events: unknown[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "wire-model-session",
      permissionMode: "default",
      model: "claude-opus-5",
    },
    { type: "assistant", message: { content: "done" } },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ];
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
    setModel,
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

interface Harness {
  client: ClaudeAgentClient;
  capturedOptionsModels: (string | undefined)[];
  setModelCalls: (string | undefined)[];
}

function createHarness(): Harness {
  const capturedOptionsModels: (string | undefined)[] = [];
  const setModelCalls: (string | undefined)[] = [];
  const setModel = vi.fn(async (modelId?: string) => {
    setModelCalls.push(modelId);
  }) as unknown as Query["setModel"];

  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    capturedOptionsModels.push(options.model);
    return createQueryMock(setModel);
  });

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });

  return { client, capturedOptionsModels, setModelCalls };
}

describe("Claude wire model ID handoff", () => {
  test("hands Claude Code the 1M wire ID when a session starts on Opus 5", async () => {
    const { client, capturedOptionsModels } = createHarness();
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-5",
    });

    try {
      await session.run("hello");
      expect(capturedOptionsModels).toContain("claude-opus-5[1m]");
      expect(capturedOptionsModels).not.toContain("claude-opus-5");
    } finally {
      await session.close();
    }
  });

  test("keeps reporting the catalog ID to callers", async () => {
    const { client } = createHarness();
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-5",
    });

    try {
      await session.run("hello");
      // The suffix is a wire-level detail. Anything user-facing has to stay on the
      // catalog ID, otherwise the model picker cannot match the running model.
      const runtimeInfo = await session.getRuntimeInfo();
      expect(runtimeInfo.model).toBe("claude-opus-5");
    } finally {
      await session.close();
    }
  });

  test("hands Claude Code the 1M wire ID when switching to Opus 5 at runtime", async () => {
    const { client, setModelCalls } = createHarness();
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-sonnet-5",
    });

    try {
      await session.run("hello");
      await session.setModel("claude-opus-5");
      expect(setModelCalls).toContain("claude-opus-5[1m]");
      expect(setModelCalls).not.toContain("claude-opus-5");
    } finally {
      await session.close();
    }
  });

  test("leaves a 200K model untouched on both handoff paths", async () => {
    const { client, capturedOptionsModels, setModelCalls } = createHarness();
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-sonnet-5",
    });

    try {
      await session.run("hello");
      await session.setModel("claude-haiku-4-5");
      expect(capturedOptionsModels).toContain("claude-sonnet-5");
      expect(setModelCalls).toContain("claude-haiku-4-5");
      for (const modelId of [...capturedOptionsModels, ...setModelCalls]) {
        expect(modelId ?? "").not.toContain("[1m]");
      }
    } finally {
      await session.close();
    }
  });

  test("passes a custom settings.json model through unchanged", async () => {
    const { client, capturedOptionsModels } = createHarness();
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "glm-5.1",
    });

    try {
      await session.run("hello");
      expect(capturedOptionsModels).toContain("glm-5.1");
      for (const modelId of capturedOptionsModels) {
        expect(modelId ?? "").not.toContain("[1m]");
      }
    } finally {
      await session.close();
    }
  });
});
