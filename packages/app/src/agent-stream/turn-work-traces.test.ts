import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  deriveTurnWorkTraceLayout,
  isTurnTraceStreamItem,
  shouldHideCompletedTurnTraceFromMainList,
  shouldShowTurnWorkTracesHeader,
  completedTurnFooterShowsTimestampOnly,
} from "./turn-work-traces";

function ts(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, seed: number): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: ts(seed) };
}

function assistant(id: string, seed: number): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: ts(seed) };
}

function tool(id: string, seed: number): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: ts(seed),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "Shell",
        arguments: {},
        status: "completed",
      },
    },
  };
}

function speakTool(id: string, seed: number): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: ts(seed),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "speak",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: "hello", output: null },
      },
    },
  };
}

function thought(id: string, seed: number): StreamItem {
  return { kind: "thought", id, text: "think", timestamp: ts(seed), status: "ready" };
}

function filterSegment(items: StreamItem[], layout: ReturnType<typeof deriveTurnWorkTraceLayout>) {
  return items.filter(
    (item) =>
      !shouldHideCompletedTurnTraceFromMainList({
        itemId: item.id,
        traceItemIdToTurnKey: layout.traceItemIdToTurnKey,
        bundlesByTurnKey: layout.bundlesByTurnKey,
      }),
  );
}

describe("deriveTurnWorkTraceLayout", () => {
  it("groups trace items under the preceding user message", () => {
    const layout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: [user("u1", 1), tool("t1", 2), thought("th1", 3), assistant("a1", 4)],
    });
    const bundle = layout.userMessageIdToBundle.get("u1");
    expect(bundle?.traceItemIds).toEqual(new Set(["t1", "th1"]));
    expect(bundle?.assistantMessageIds).toEqual(new Set(["a1"]));
    expect(bundle?.isInFlight).toBe(false);
    expect(bundle?.timing?.durationMs).toBe(3000);
    expect(layout.assistantMessageIdToBundle.get("a1")).toBe(bundle);
  });

  it("marks the last turn in-flight while the agent is running", () => {
    const layout = deriveTurnWorkTraceLayout({
      agentStatus: "running",
      items: [user("u1", 1), tool("t1", 2), assistant("a1", 3), user("u2", 4), tool("t2", 5)],
    });
    expect(layout.userMessageIdToBundle.get("u1")?.isInFlight).toBe(false);
    expect(layout.userMessageIdToBundle.get("u2")?.isInFlight).toBe(true);
    expect(shouldShowTurnWorkTracesHeader({ bundle: layout.userMessageIdToBundle.get("u1") })).toBe(
      true,
    );
    expect(shouldShowTurnWorkTracesHeader({ bundle: layout.userMessageIdToBundle.get("u2") })).toBe(
      false,
    );
  });

  it("requires chronological order: reversed display order attaches traces incorrectly", () => {
    const chronological = [user("u1", 1), tool("t1", 2), assistant("a1", 3)];
    const reversed = chronological.toReversed();
    const chronoLayout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: chronological,
    });
    const reversedLayout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: reversed,
    });
    expect(chronoLayout.userMessageIdToBundle.get("u1")?.traceItemIds).toEqual(new Set(["t1"]));
    // Documents why view must pass chronological tail/head, not native-reversed rows.
    expect(reversedLayout.userMessageIdToBundle.get("u1")?.traceItemIds.size).toBe(0);
    expect(reversedLayout.traceItemIdToTurnKey.has("t1")).toBe(false);
  });
});

describe("shouldHideCompletedTurnTraceFromMainList", () => {
  it("hides completed turn trace items from the main list even when expanded", () => {
    const layout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: [user("u1", 1), tool("t1", 2), assistant("a1", 3)],
    });
    expect(
      shouldHideCompletedTurnTraceFromMainList({
        itemId: "t1",
        traceItemIdToTurnKey: layout.traceItemIdToTurnKey,
        bundlesByTurnKey: layout.bundlesByTurnKey,
      }),
    ).toBe(true);
  });

  it("keeps in-flight trace items in the main list", () => {
    const layout = deriveTurnWorkTraceLayout({
      agentStatus: "running",
      items: [user("u1", 1), tool("t1", 2)],
    });
    expect(
      shouldHideCompletedTurnTraceFromMainList({
        itemId: "t1",
        traceItemIdToTurnKey: layout.traceItemIdToTurnKey,
        bundlesByTurnKey: layout.bundlesByTurnKey,
      }),
    ).toBe(false);
  });

  it("hides traces in a later segment when filtered with the full-stream layout", () => {
    const fullItems = [
      user("u1", 1),
      tool("t1", 2),
      assistant("a1", 3),
      user("u2", 4),
      tool("t2", 5),
      assistant("a2", 6),
    ];
    const layout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: fullItems,
    });
    // Segment without the parent user message (e.g. liveHead-only slice).
    const laterSegment = [tool("t2", 5), assistant("a2", 6)];
    const localLayout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: laterSegment,
    });
    expect(localLayout.traceItemIdToTurnKey.has("t2")).toBe(false);
    expect(filterSegment(laterSegment, layout).map((item) => item.id)).toEqual(["a2"]);
  });
});

describe("isTurnTraceStreamItem", () => {
  it("excludes agent speak tool calls from work traces", () => {
    expect(isTurnTraceStreamItem(tool("t1", 1))).toBe(true);
    expect(isTurnTraceStreamItem(speakTool("s1", 2))).toBe(false);
    expect(isTurnTraceStreamItem(thought("th1", 3))).toBe(true);
  });

  it("keeps speak tool calls visible in the main list after the turn completes", () => {
    const layout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: [user("u1", 1), tool("t1", 2), speakTool("s1", 3), assistant("a1", 4)],
    });
    expect(layout.userMessageIdToBundle.get("u1")?.traceItemIds).toEqual(new Set(["t1"]));
    expect(
      shouldHideCompletedTurnTraceFromMainList({
        itemId: "s1",
        traceItemIdToTurnKey: layout.traceItemIdToTurnKey,
        bundlesByTurnKey: layout.bundlesByTurnKey,
      }),
    ).toBe(false);
  });
});

describe("completedTurnFooterShowsTimestampOnly", () => {
  it("is true when work traces header owns turn duration", () => {
    const layout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: [user("u1", 1), tool("t1", 2), assistant("a1", 3)],
    });
    expect(
      completedTurnFooterShowsTimestampOnly({
        assistantMessageId: "a1",
        bundlesByTurnKey: layout.bundlesByTurnKey,
        assistantMessageIdToBundle: layout.assistantMessageIdToBundle,
      }),
    ).toBe(true);
  });
});
