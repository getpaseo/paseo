import { expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryFactory } from "./query.js";

const LIMIT = "You've hit your session limit · resets 5:20pm (Asia/Singapore)";

interface ScriptedTurn {
  // An API error reply as Claude Code writes it: a synthetic assistant message with `error`.
  errorReply?: string;
  // Assistant text the model wrote before or after it.
  before?: string;
  after?: string;
  isError: boolean;
}

// A query dependency that speaks Claude Code's stream interface, one scripted turn per prompt.
function scriptedQuery(turns: ScriptedTurn[]): ClaudeQueryFactory {
  return ({ prompt }) => {
    let index = 0;
    const assistant = (id: string, text: string, error?: string) => ({
      type: "assistant",
      session_id: "error-session",
      parent_tool_use_id: null,
      uuid: id,
      message: {
        id,
        role: "assistant",
        model: error ? "<synthetic>" : "claude-opus-5-5",
        content: [{ type: "text", text }],
        stop_reason: "stop_sequence",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      ...(error ? { error } : {}),
    });
    const messages = (async function* () {
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      for await (const _message of prompt) {
        const turn = turns[index];
        index += 1;
        yield {
          type: "system",
          subtype: "init",
          session_id: "error-session",
          permissionMode: "default",
          model: "claude-opus-5-5",
        };
        if (turn.before) yield assistant(`before-${index}`, turn.before);
        if (turn.errorReply) yield assistant(`error-${index}`, turn.errorReply, "rate_limit");
        if (turn.after) yield assistant(`after-${index}`, turn.after);
        yield {
          type: "result",
          subtype: "success",
          session_id: "error-session",
          duration_ms: 1,
          duration_api_ms: 0,
          is_error: turn.isError,
          num_turns: 1,
          result: turn.isError ? (turn.errorReply ?? "") : (turn.after ?? turn.errorReply ?? ""),
          stop_reason: "stop_sequence",
          total_cost_usd: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: `result-${index}`,
        };
      }
    })();
    return Object.assign(messages, {
      close: () => {
        void messages.return();
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
    }) as ReturnType<ClaudeQueryFactory>;
  };
}

async function runTurns(turns: ScriptedTurn[]) {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: scriptedQuery(turns),
    resolveBinary: async () => process.execPath,
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
  try {
    const results = [];
    for (const [index] of turns.entries()) {
      results.push(await collectSessionTurnEvents(session, `turn ${index + 1}`));
    }
    return results;
  } finally {
    await session.close();
  }
}

function assistantTexts(events: Awaited<ReturnType<typeof runTurns>>[number]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
}

function terminal(events: Awaited<ReturnType<typeof runTurns>>[number]) {
  return events.find(
    (event) =>
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled",
  );
}

test("a turn Claude Code ends on an API error fails with the error, shown once", async () => {
  const [limited, overloaded, next] = await runTurns([
    { errorReply: LIMIT, isError: true },
    {
      before: "Checking the deploy doc.",
      errorReply: "API Error: 529 Overloaded",
      isError: true,
    },
    { after: "Done.", isError: false },
  ]);

  expect(terminal(limited)).toMatchObject({
    type: "turn_failed",
    error: LIMIT,
  });
  expect(assistantTexts(limited)).toEqual([]);

  expect(terminal(overloaded)).toMatchObject({
    type: "turn_failed",
    error: "API Error: 529 Overloaded",
  });
  expect(assistantTexts(overloaded)).toEqual(["Checking the deploy doc."]);

  // The session keeps working after a failed turn.
  expect(terminal(next)).toMatchObject({ type: "turn_completed" });
  expect(assistantTexts(next)).toEqual(["Done."]);
});

test("an error reply the turn moves past is still shown", async () => {
  const [recovered, completed] = await runTurns([
    {
      errorReply: "API Error: 529 Overloaded",
      after: "Recovered.",
      isError: false,
    },
    { errorReply: LIMIT, isError: false },
  ]);

  expect(terminal(recovered)).toMatchObject({ type: "turn_completed" });
  expect(assistantTexts(recovered)).toEqual(["API Error: 529 Overloaded", "Recovered."]);

  expect(terminal(completed)).toMatchObject({ type: "turn_completed" });
  expect(assistantTexts(completed)).toEqual([LIMIT]);
});
