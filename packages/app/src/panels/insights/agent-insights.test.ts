import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { computeAgentInsights } from "./agent-insights";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, seconds));

function toolCall(
  id: string,
  seconds: number,
  name: string,
  detail: unknown,
  status = "completed",
): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: at(seconds),
    payload: {
      source: "agent",
      data: { provider: "claude", callId: id, name, status, error: null, detail },
    },
  } as StreamItem;
}

describe("computeAgentInsights", () => {
  it("counts tools, tests, compactions and reads Jev decisions from every result shape", () => {
    const jevResult = {
      answers: {
        next: { choice: "implement", confidence: 0.58 },
        effort: { choice: "medium", confidence: 0.74 },
      },
      latencyMs: 79,
    };
    const items: StreamItem[] = [
      { kind: "user_message", id: "u1", text: "fix it", timestamp: at(0) } as StreamItem,
      toolCall("t1", 5, "Bash", { type: "shell", command: "cargo test strings" }, "failed"),
      toolCall("t2", 9, "Edit", { type: "edit", filePath: "a.rs" }),
      toolCall("j1", 10, "mcp__paseo__system_one_decide", {
        type: "unknown",
        input: {},
        output: { content: [{ type: "text", text: JSON.stringify(jevResult) }] },
      }),
      { kind: "compaction", id: "c1", timestamp: at(20), status: "completed" } as StreamItem,
      {
        kind: "notification",
        sourceType: "notification",
        id: "n1",
        timestamp: at(30),
        level: "info",
        message: "Jev routed this turn: claude-haiku-4-5 · low",
      } as StreamItem,
    ];

    const insights = computeAgentInsights(items);

    expect(insights).toMatchObject({
      toolCalls: 2,
      failedToolCalls: 1,
      toolCallsByKind: { shell: 1, edit: 1 },
      testRuns: 1,
      compactions: 1,
      turns: 1,
      jevLatencyMs: 79,
      spanMs: 30_000,
    });
    expect(insights.jevDecisions.map((d) => [d.question, d.choice, d.confidence])).toEqual([
      ["next", "implement", 0.58],
      ["effort", "medium", 0.74],
      ["route", "claude-haiku-4-5 · low", null],
    ]);
  });

  it("reads the result Claude nests in its own output field", () => {
    const items = [
      toolCall("j1", 0, "mcp__paseo__system_one_decide", {
        type: "unknown",
        input: {},
        output: {
          output: {
            answers: { next: { type: "choice", choice: "inspect", confidence: 0.71 } },
            model: "jev-1.13.0",
            latencyMs: 497,
          },
        },
      }),
    ];
    const insights = computeAgentInsights(items);
    expect(insights.jevDecisions.map((d) => [d.question, d.choice, d.confidence])).toEqual([
      ["next", "inspect", 0.71],
    ]);
    expect(insights.jevLatencyMs).toBe(497);
  });

  it("is empty for an empty timeline", () => {
    expect(computeAgentInsights([])).toMatchObject({ toolCalls: 0, jevDecisions: [], spanMs: 0 });
  });
});
