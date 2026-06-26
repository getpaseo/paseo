import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  deriveTurnWorkTraceLayout,
  shouldHideCompletedTurnTraceFromMainList,
  shouldShowTurnWorkTracesHeader,
  shouldSuppressCompletedTurnFooter,
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

function thought(id: string, seed: number): StreamItem {
  return { kind: "thought", id, text: "think", timestamp: ts(seed), status: "ready" };
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
});

describe("shouldSuppressCompletedTurnFooter", () => {
  it("suppresses assistant footer when work traces header owns duration", () => {
    const layout = deriveTurnWorkTraceLayout({
      agentStatus: "idle",
      items: [user("u1", 1), tool("t1", 2), assistant("a1", 3)],
    });
    expect(
      shouldSuppressCompletedTurnFooter({
        assistantMessageId: "a1",
        bundlesByTurnKey: layout.bundlesByTurnKey,
      }),
    ).toBe(true);
  });
});