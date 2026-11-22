import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";
import { ClaudeResultMeter } from "./metrics.js";
import type { ClaudeQueryFactory } from "./query.js";

function result(fields: Record<string, unknown> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "metrics-session",
    duration_ms: 9_000,
    duration_api_ms: 6_000,
    ttft_ms: 800,
    is_error: false,
    num_turns: 3,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 1_000,
      output_tokens: 600,
      cache_read_input_tokens: 3_000,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      "claude-sonnet-4-6": { inputTokens: 1_000, outputTokens: 600 },
      "claude-haiku-4-5": { inputTokens: 500, outputTokens: 100 },
    },
    permission_denials: [],
    uuid: "result-1",
    ...fields,
  } as unknown as SDKResultMessage;
}

describe("Claude result metrics", () => {
  test("a turn reports its model, timing, steps, tokens and cache, and the session its totals", () => {
    const meter = new ClaudeResultMeter();
    meter.queryStarted();
    expect(meter.observe(result(), "claude-sonnet-4-6")).toEqual({
      turn: [
        { label: "Model", value: "claude-sonnet-4-6" },
        { label: "Elapsed", value: "9.0s" },
        { label: "Model time", value: "6.0s" },
        { label: "TTFT", value: "0.8s" },
        { label: "Steps", value: "3" },
        { label: "Tokens", value: "1.0K ↑ · 600 ↓" },
        { label: "Cache", value: "75%", tone: "ok" },
        // The first result of a query carries earlier spend too, so its own cost is unknown.
      ],
      session: [
        // Every model the session called, the haiku side calls included.
        { label: "Tokens", value: "1.5K ↑ · 700 ↓" },
        { label: "Cache (last turn)", value: "75%", tone: "ok" },
        { label: "Cost", value: "$0.050" },
      ],
    });
  });

  test("a turn's cost is the change in the query's running total", () => {
    const meter = new ClaudeResultMeter();
    meter.queryStarted();
    meter.observe(result({ total_cost_usd: 0.05 }), null);
    const cost = (fields: Record<string, unknown>) =>
      meter.observe(result(fields), null).turn.find((metric) => metric.label === "Cost")?.value;
    expect(cost({ total_cost_usd: 0.08 })).toBe("$0.030");
    // A crashed run zeroes the total; the next turn counts from the last real total.
    expect(cost({ subtype: "error_during_execution", total_cost_usd: 0 })).toBeUndefined();
    expect(cost({ total_cost_usd: 0.1 })).toBe("$0.020");
    // A cleared session restarts the total.
    expect(cost({ total_cost_usd: 0.01 })).toBeUndefined();
    expect(cost({ total_cost_usd: 0.015 })).toBe("$0.005");
    meter.queryStarted();
    expect(cost({ total_cost_usd: 0.2 })).toBeUndefined();
  });

  test("an error result does not replace the session's totals", () => {
    const meter = new ClaudeResultMeter();
    expect(
      meter.observe(result({ subtype: "error_during_execution", total_cost_usd: 0 }), null).session,
    ).toBeNull();
  });

  test("missing or malformed values hide only their metrics", () => {
    const meter = new ClaudeResultMeter();
    expect(
      meter.observe(
        result({
          duration_api_ms: -1,
          ttft_ms: undefined,
          num_turns: 1,
          usage: { output_tokens: 5 },
          modelUsage: { broken: {} },
          total_cost_usd: Number.NaN,
        }),
        null,
      ),
    ).toEqual({ turn: [{ label: "Elapsed", value: "9.0s" }], session: [] });
  });
});

// A query that answers each prompt with init and a result, the way Claude Code does.
function resultQuery(results: Array<Record<string, unknown>>): ClaudeQueryFactory {
  return ({ prompt }) => {
    let turn = 0;
    const messages = (async function* () {
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      for await (const _message of prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "metrics-session",
          permissionMode: "default",
          model: "claude-sonnet-4-6",
        };
        yield result({ uuid: `result-${turn}`, ...results[turn] });
        turn += 1;
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

test("completed Claude turns carry their metrics and update the session's", async () => {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => process.execPath,
    queryFactory: resultQuery([{ total_cost_usd: 0.05 }, { total_cost_usd: 0.09 }]),
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await collectSessionTurnEvents(session, "first turn");
    const second = await collectSessionTurnEvents(session, "second turn");
    const completed = second.find((event) => event.type === "turn_completed");
    expect(completed?.type === "turn_completed" ? completed.metrics : undefined).toEqual([
      { label: "Model", value: "claude-sonnet-4-6" },
      { label: "Elapsed", value: "9.0s" },
      { label: "Model time", value: "6.0s" },
      { label: "TTFT", value: "0.8s" },
      { label: "Steps", value: "3" },
      { label: "Tokens", value: "1.0K ↑ · 600 ↓" },
      { label: "Cache", value: "75%", tone: "ok" },
      { label: "Cost", value: "$0.040" },
    ]);
    // Session totals follow the turn's outcome.
    await expect
      .poll(() => events.filter((event) => event.type === "session_metrics_updated").at(1))
      .toMatchObject({
        metrics: [
          { label: "Tokens", value: "1.5K ↑ · 700 ↓" },
          { label: "Cache (last turn)", value: "75%", tone: "ok" },
          { label: "Cost", value: "$0.090" },
        ],
      });
  } finally {
    await session.close();
  }
});
