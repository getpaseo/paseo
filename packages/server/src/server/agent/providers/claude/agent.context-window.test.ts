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
