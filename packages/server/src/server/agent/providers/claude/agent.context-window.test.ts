import { expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryFactory } from "./query.js";

// A query dependency that speaks the same stream interface as Claude Code.
// Each request repeats init so a second turn exercises runtime-limit retention.
function contextQuery(runtimeModel: string, reportedLimit: number): ClaudeQueryFactory {
  return ({ prompt }) => {
    let model = runtimeModel;
    const messages = (async function* () {
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      for await (const _message of prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "context-session",
          permissionMode: "default",
          model,
        };
        yield {
          type: "stream_event",
          session_id: "context-session",
          event: { type: "message_start", message: { usage: { input_tokens: 249_950 } } },
        };
        yield {
          type: "stream_event",
          session_id: "context-session",
          event: { type: "message_delta", usage: { output_tokens: 50 } },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "context-session",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 249_950, output_tokens: 50, cache_read_input_tokens: 0 },
          modelUsage: { [model]: { contextWindow: reportedLimit } },
          permission_denials: [],
          uuid: "context-result",
        };
      }
    })();
    return Object.assign(messages, {
      close: () => {
        void messages.return();
      },
      interrupt: async () => undefined,
      setModel: async (value: string) => {
        model = value;
      },
      setPermissionMode: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
    }) as ReturnType<ClaudeQueryFactory>;
  };
}

test.each([
  { selected: "glm-5.2[1m]", runtime: "glm-5.2[1m]", expected: 1_000_000 },
  { selected: "sonnet", runtime: "glm-5.2[1m]", expected: 1_000_000 },
  { selected: "glm-5.2", runtime: "glm-5.2", expected: undefined },
])(
  "streams the context limit for $selected resolved as $runtime",
  async ({ selected, runtime, expected }) => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: contextQuery(runtime, 800_000),
      resolveBinary: async () => process.execPath,
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: selected,
    });
    try {
      const first = await collectSessionTurnEvents(session, "first turn");
      const live = first.filter((event) => event.type === "usage_updated");
      expect(live.map((event) => event.usage.contextWindowMaxTokens)).toEqual([expected, expected]);
      expect(live.map((event) => event.usage.contextWindowUsedTokens)).toEqual([249_950, 250_000]);
      expect(first).toContainEqual(
        expect.objectContaining({
          type: "turn_completed",
          usage: expect.objectContaining({ contextWindowMaxTokens: 800_000 }),
        }),
      );

      const second = await collectSessionTurnEvents(session, "second turn");
      expect(
        second
          .filter((event) => event.type === "usage_updated")
          .map((event) => event.usage.contextWindowMaxTokens),
      ).toEqual([800_000, 800_000]);

      await session.setModel?.("another-custom-model");
      const switched = await collectSessionTurnEvents(session, "after model switch");
      expect(
        switched
          .filter((event) => event.type === "usage_updated")
          .map((event) => event.usage.contextWindowMaxTokens),
      ).toEqual([undefined, undefined]);
    } finally {
      await session.close();
    }
  },
);

test("retains 200k context limit after switching back from a 1M model when modelUsage contains both", async () => {
  let activeModel = "claude-opus-4-8[1m]";
  const accumulatedModelUsage: Record<string, { contextWindow: number }> = {
    "claude-opus-4-8[1m]": { contextWindow: 1_000_000 },
  };

  const queryFactory: ClaudeQueryFactory = ({ prompt }) => {
    const messages = (async function* () {
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      for await (const _message of prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "context-session",
          permissionMode: "default",
          model: activeModel,
        };
        yield {
          type: "stream_event",
          session_id: "context-session",
          event: { type: "message_start", message: { usage: { input_tokens: 10_000 } } },
        };
        yield {
          type: "stream_event",
          session_id: "context-session",
          event: { type: "message_delta", usage: { output_tokens: 50 } },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "context-session",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 10_000, output_tokens: 50, cache_read_input_tokens: 0 },
          modelUsage: { ...accumulatedModelUsage },
          permission_denials: [],
          uuid: "context-result",
        };
      }
    })();
    return Object.assign(messages, {
      close: () => {
        void messages.return();
      },
      interrupt: async () => undefined,
      setModel: async (value: string) => {
        activeModel = value;
        accumulatedModelUsage[value] = {
          contextWindow: value.includes("[1m]") ? 1_000_000 : 200_000,
        };
      },
      setPermissionMode: async () => undefined,
      applyFlagSettings: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
    }) as ReturnType<ClaudeQueryFactory>;
  };

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => process.execPath,
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: "claude-opus-4-8[1m]",
  });
  try {
    const firstTurn = await collectSessionTurnEvents(session, "first turn with 1m");
    expect(firstTurn).toContainEqual(
      expect.objectContaining({
        type: "turn_completed",
        usage: expect.objectContaining({ contextWindowMaxTokens: 1_000_000 }),
      }),
    );

    // Switch back to 200k model
    await session.setModel?.("claude-haiku-4-5");

    const secondTurn = await collectSessionTurnEvents(session, "second turn with 200k");
    const liveUsage = secondTurn.filter((event) => event.type === "usage_updated");
    expect(liveUsage.map((event) => event.usage.contextWindowMaxTokens)).toEqual([
      200_000, 200_000,
    ]);
    expect(secondTurn).toContainEqual(
      expect.objectContaining({
        type: "turn_completed",
        usage: expect.objectContaining({ contextWindowMaxTokens: 200_000 }),
      }),
    );

    // Third turn to verify subsequent turn retains 200_000
    const thirdTurn = await collectSessionTurnEvents(session, "third turn with 200k");
    const thirdLiveUsage = thirdTurn.filter((event) => event.type === "usage_updated");
    expect(thirdLiveUsage.map((event) => event.usage.contextWindowMaxTokens)).toEqual([
      200_000, 200_000,
    ]);
    expect(thirdTurn).toContainEqual(
      expect.objectContaining({
        type: "turn_completed",
        usage: expect.objectContaining({ contextWindowMaxTokens: 200_000 }),
      }),
    );
  } finally {
    await session.close();
  }
});

test("matches active model via case-insensitive, normalized ID, or substring match across accumulated modelUsage", async () => {
  let activeModel = "claude-sonnet-4-6";
  const accumulatedModelUsage: Record<string, { contextWindow: number }> = {
    // 1M model from a previous turn
    "claude-opus-4-6[1m]": { contextWindow: 1_000_000 },
    // Versioned runtime key for sonnet that normalizes to claude-sonnet-4-6
    "claude-sonnet-4-6-20260101": { contextWindow: 200_000 },
  };

  const queryFactory: ClaudeQueryFactory = ({ prompt }) => {
    const messages = (async function* () {
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      for await (const _message of prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "context-session",
          permissionMode: "default",
          model: activeModel,
        };
        yield {
          type: "stream_event",
          session_id: "context-session",
          event: { type: "message_start", message: { usage: { input_tokens: 5_000 } } },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "context-session",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 5_000, output_tokens: 50, cache_read_input_tokens: 0 },
          modelUsage: { ...accumulatedModelUsage },
          permission_denials: [],
          uuid: "context-result",
        };
      }
    })();
    return Object.assign(messages, {
      close: () => {
        void messages.return();
      },
      interrupt: async () => undefined,
      setModel: async (value: string) => {
        activeModel = value;
      },
      setPermissionMode: async () => undefined,
      applyFlagSettings: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
    }) as ReturnType<ClaudeQueryFactory>;
  };

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => process.execPath,
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: "claude-sonnet-4-6",
  });
  try {
    const turn = await collectSessionTurnEvents(session, "turn with normalized model match");
    expect(turn).toContainEqual(
      expect.objectContaining({
        type: "turn_completed",
        usage: expect.objectContaining({ contextWindowMaxTokens: 200_000 }),
      }),
    );

    // Switch to uppercase version of 1M model
    await session.setModel?.("CLAUDE-OPUS-4-6[1M]");
    const secondTurn = await collectSessionTurnEvents(session, "turn with uppercase model match");
    expect(secondTurn).toContainEqual(
      expect.objectContaining({
        type: "turn_completed",
        usage: expect.objectContaining({ contextWindowMaxTokens: 1_000_000 }),
      }),
    );
  } finally {
    await session.close();
  }
});

test("falls back to single modelUsage entry or manifest limit when active model key is not in modelUsage", async () => {
  let activeModel = "custom-unlisted-model";
  const accumulatedModelUsage: Record<string, { contextWindow: number }> = {
    "reported-runtime-model": { contextWindow: 350_000 },
  };

  const queryFactory: ClaudeQueryFactory = ({ prompt }) => {
    const messages = (async function* () {
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      for await (const _message of prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "context-session",
          permissionMode: "default",
          model: activeModel,
        };
        yield {
          type: "stream_event",
          session_id: "context-session",
          event: { type: "message_start", message: { usage: { input_tokens: 1_000 } } },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "context-session",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 0 },
          modelUsage: { ...accumulatedModelUsage },
          permission_denials: [],
          uuid: "context-result",
        };
      }
    })();
    return Object.assign(messages, {
      close: () => {
        void messages.return();
      },
      interrupt: async () => undefined,
      setModel: async (value: string) => {
        activeModel = value;
      },
      setPermissionMode: async () => undefined,
      applyFlagSettings: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
    }) as ReturnType<ClaudeQueryFactory>;
  };

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => process.execPath,
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: "custom-unlisted-model",
  });
  try {
    const turn = await collectSessionTurnEvents(session, "turn with single entry fallback");
    expect(turn).toContainEqual(
      expect.objectContaining({
        type: "turn_completed",
        usage: expect.objectContaining({ contextWindowMaxTokens: 350_000 }),
      }),
    );
  } finally {
    await session.close();
  }
});
