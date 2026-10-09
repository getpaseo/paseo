import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { buildAgentStreamRenderModel } from "./model";
import { layoutStream } from "./layout";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import { continuesTurn } from "./turn-membership";

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, second: number, turnId: string): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at(second), turnId };
}

function assistant(id: string, second: number, turnId: string): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second), turnId };
}

function runningTool(id: string, second: number, turnId: string): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: at(second),
    turnId,
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "Bash",
        status: "running",
        error: null,
        detail: { type: "unknown", input: null, output: null },
      },
    },
  };
}

function layoutFor(items: StreamItem[], isTurnActive: boolean) {
  const model = buildAgentStreamRenderModel({
    isTurnActive,
    activeTurnStartedAt: isTurnActive ? at(1) : null,
    tail: items,
    head: [],
    platform: "web",
    isMobileBreakpoint: false,
  });
  return {
    model,
    layout: layoutStream({
      strategy: resolveStreamRenderStrategy({ platform: "web", isMobileBreakpoint: false }),
      isTurnActive,
      history: model.segments.historyMounted,
      liveHead: model.segments.liveHead,
      timingByAssistantId: model.turnTiming.byAssistantId,
    }),
  };
}

function completedFooterIds(layout: ReturnType<typeof layoutFor>["layout"]): string[] {
  return [
    ...layout.history.flatMap((row) => (row.completedFooter ? [row.completedFooter.itemId] : [])),
    ...layout.liveHead.flatMap((row) => (row.completedFooter ? [row.completedFooter.itemId] : [])),
    ...(layout.auxiliaryTurnFooter ? [layout.auxiliaryTurnFooter.itemId] : []),
  ];
}

describe("canonical turn membership", () => {
  it("stops tagged traversal at every mismatching turn ID", () => {
    expect(continuesTurn(assistant("first", 1, "turn-1"), runningTool("next", 2, "turn-2"))).toBe(
      false,
    );
    expect(continuesTurn(runningTool("first", 1, "turn-1"), assistant("next", 2, "turn-1"))).toBe(
      true,
    );
  });

  it("renders adjacent turns without visible prompts as one response", () => {
    const items = [
      user("prompt", 1, "turn-1"),
      assistant("first reply", 2, "turn-1"),
      runningTool("heartbeat-1-tool", 3, "turn-2"),
      assistant("heartbeat-1-reply", 4, "turn-2"),
      runningTool("heartbeat-2-tool", 5, "turn-3"),
      assistant("heartbeat-2-reply", 6, "turn-3"),
    ];

    const completed = layoutFor(items, false);

    expect(completedFooterIds(completed.layout)).toEqual(["heartbeat-2-reply"]);
    expect(completed.layout.auxiliaryTurnFooter?.timing).toEqual({
      completedAt: at(6),
      durationMs: null,
    });
  });

  it.each([
    [
      "Claude",
      (turnId: string) => [
        user("prompt", 1, turnId),
        runningTool("sleep", 2, turnId),
        user("hello", 3, turnId),
      ],
    ],
    [
      "Codex",
      (turnId: string) => [
        user("prompt", 1, turnId),
        assistant("preface", 2, turnId),
        runningTool("sleep", 3, turnId),
        user("hello", 4, turnId),
      ],
    ],
  ] as const)("keeps %s-shaped active steers in one visible turn", (_provider, build) => {
    const turnId = "turn-1";
    const active = layoutFor(build(turnId), true);

    expect(completedFooterIds(active.layout)).toEqual([]);
    expect(active.model.turnTiming.runningStartedAt).toEqual(at(1));

    const completedItems = [...build(turnId), assistant("done", 9, turnId)];
    const completed = layoutFor(completedItems, false);
    expect(completedFooterIds(completed.layout)).toEqual(["done"]);
    expect(completed.model.turnTiming.byAssistantId.get("done")).toMatchObject({
      completedAt: at(9),
      durationMs: 8000,
    });
  });
});
