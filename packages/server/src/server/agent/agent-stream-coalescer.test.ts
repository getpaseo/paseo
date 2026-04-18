import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentProvider, AgentStreamEvent } from "./agent-sdk-types.js";
import {
  AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
  AgentStreamCoalescer,
  type AgentStreamCoalescerFlush,
  type AgentStreamCoalescerTimers,
} from "./agent-stream-coalescer.js";

function createHarness(windowMs?: number) {
  const flushes: AgentStreamCoalescerFlush[] = [];
  const timers: AgentStreamCoalescerTimers = {
    setTimeout,
    clearTimeout,
  };
  const coalescer = new AgentStreamCoalescer({
    ...(windowMs !== undefined ? { windowMs } : {}),
    timers,
    onFlush: (payload) => {
      flushes.push(payload);
    },
  });

  return { coalescer, flushes };
}

function timeline(
  item: Extract<AgentStreamEvent, { type: "timeline" }>["item"],
  options?: {
    provider?: AgentProvider;
    turnId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return {
    type: "timeline",
    item,
    provider: options?.provider ?? "codex",
    ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
  };
}

function assistant(
  text: string,
  options?: {
    provider?: AgentProvider;
    turnId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return timeline({ type: "assistant_message", text }, options);
}

function reasoning(
  text: string,
  options?: {
    provider?: AgentProvider;
    turnId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return timeline({ type: "reasoning", text }, options);
}

describe("AgentStreamCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("coalesces same-tick assistant chunks after the configured window", async () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant("hel"))).toBe(true);
    expect(coalescer.handle("agent-1", assistant("lo"))).toBe(true);

    expect(flushes).toEqual([]);
    await vi.advanceTimersByTimeAsync(32);
    expect(flushes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "hello" },
        provider: "codex",
      },
    ]);
  });

  test("uses constructor windowMs instead of a hard-coded value", async () => {
    const { coalescer, flushes } = createHarness(10);

    expect(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS).toBe(33);
    expect(coalescer.handle("agent-1", assistant("fast"))).toBe(true);

    await vi.advanceTimersByTimeAsync(9);
    expect(flushes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "fast" },
        provider: "codex",
      },
    ]);
  });

  test("flushes before non-chunkable boundaries when caller invokes flushFor", () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant("before"))).toBe(true);
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "before" },
        provider: "codex",
      },
    ]);
    expect(
      coalescer.handle(
        "agent-1",
        timeline({
          type: "tool_call",
          callId: "tool-1",
          name: "shell",
          status: "running",
          error: null,
        }),
      ),
    ).toBe(false);
  });

  test("does not consume non-chunkable events", () => {
    const { coalescer, flushes } = createHarness();
    const nonChunkableEvents: AgentStreamEvent[] = [
      timeline({
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "completed",
        error: null,
      }),
      timeline({ type: "todo", items: [{ text: "ship it", completed: false }] }),
      timeline({ type: "user_message", text: "hi", messageId: "message-1" }),
      timeline({ type: "error", message: "boom" }),
      timeline({ type: "compaction", status: "loading", trigger: "auto" }),
      { type: "thread_started", provider: "codex", sessionId: "session-1" },
      { type: "turn_started", provider: "codex", turnId: "turn-1" },
      { type: "turn_completed", provider: "codex", turnId: "turn-1" },
      { type: "turn_failed", provider: "codex", error: "failed", turnId: "turn-1" },
      { type: "turn_canceled", provider: "codex", reason: "canceled", turnId: "turn-1" },
      { type: "usage_updated", provider: "codex", usage: { inputTokens: 1 }, turnId: "turn-1" },
      {
        type: "permission_requested",
        provider: "codex",
        turnId: "turn-1",
        request: {
          id: "permission-1",
          provider: "codex",
          name: "shell",
          kind: "tool",
        },
      },
      {
        type: "permission_resolved",
        provider: "codex",
        turnId: "turn-1",
        requestId: "permission-1",
        resolution: { behavior: "allow" },
      },
      {
        type: "attention_required",
        provider: "codex",
        reason: "permission",
        timestamp: "2026-04-18T00:00:00.000Z",
      },
    ];

    for (const event of nonChunkableEvents) {
      expect(coalescer.handle("agent-1", event)).toBe(false);
    }
    expect(flushes).toEqual([]);
  });

  test("preserves kind boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a1"));
    coalescer.handle("agent-1", reasoning("r1"));
    coalescer.handle("agent-1", assistant("a2"));

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a1" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "reasoning", text: "r1" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a2" },
        provider: "codex",
      },
    ]);
  });

  test("preserves strict alternating assistant/reasoning order", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a1"));
    coalescer.handle("agent-1", reasoning("r1"));
    coalescer.handle("agent-1", assistant("a2"));
    coalescer.handle("agent-1", reasoning("r2"));

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", text: "a1" },
      { type: "reasoning", text: "r1" },
      { type: "assistant_message", text: "a2" },
      { type: "reasoning", text: "r2" },
    ]);
  });

  test("does not collapse across provider boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("c", { provider: "codex" }));
    coalescer.handle("agent-1", assistant("o", { provider: "opencode" }));

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "c" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "o" },
        provider: "opencode",
      },
    ]);
  });

  test("does not collapse across turnId boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("one", { turnId: "turn-1" }));
    coalescer.handle("agent-1", assistant("two", { turnId: "turn-2" }));

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "one" },
        provider: "codex",
        turnId: "turn-1",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "two" },
        provider: "codex",
        turnId: "turn-2",
      },
    ]);
  });

  test("drops empty text chunks", async () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant(""))).toBe(true);
    expect(coalescer.handle("agent-2", reasoning(""))).toBe(true);

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([]);
  });

  test("preserves whitespace byte-exactly", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant(" "));
    coalescer.handle("agent-1", assistant("\n"));
    coalescer.handle("agent-1", assistant("\t"));
    coalescer.handle("agent-1", assistant(" mixed \n\t whitespace "));

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "assistant_message",
          text: " \n\t mixed \n\t whitespace ",
        },
        provider: "codex",
      },
    ]);
  });

  test("reconstructs bytes exactly for fragmented text", async () => {
    const { coalescer, flushes } = createHarness();
    const text = "Hello, 世界.\nPunctuation: ,.!?;: — but JS strings stay intact.\n";
    const chunks = [
      "Hello",
      ", ",
      "世界",
      ".\n",
      "Punctuation: ,.!?;: ",
      "—",
      " but JS strings stay intact.\n",
    ];

    for (const chunk of chunks) {
      coalescer.handle("agent-1", assistant(chunk));
    }

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text },
        provider: "codex",
      },
    ]);
  });

  test("isolates buffers per agent", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a"));
    coalescer.handle("agent-2", assistant("x"));
    coalescer.handle("agent-1", assistant("b"));
    coalescer.handle("agent-2", assistant("y"));

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "ab" },
        provider: "codex",
      },
      {
        agentId: "agent-2",
        item: { type: "assistant_message", text: "xy" },
        provider: "codex",
      },
    ]);
  });

  test("flushAll flushes every pending agent once", () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a"));
    coalescer.handle("agent-2", assistant("b"));

    coalescer.flushAll();
    coalescer.flushAll();

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a" },
        provider: "codex",
      },
      {
        agentId: "agent-2",
        item: { type: "assistant_message", text: "b" },
        provider: "codex",
      },
    ]);
  });

  test("flushFor is idempotent", () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("once"));
    coalescer.flushFor("agent-1");
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "once" },
        provider: "codex",
      },
    ]);
  });

  test("chunks appended during onFlush use a later buffer", async () => {
    const flushes: AgentStreamCoalescerFlush[] = [];
    let coalescer!: AgentStreamCoalescer;
    coalescer = new AgentStreamCoalescer({
      timers: {
        setTimeout,
        clearTimeout,
      },
      onFlush: (payload) => {
        flushes.push(payload);
        if (payload.agentId === "agent-1" && payload.item.text === "first") {
          coalescer.handle("agent-1", assistant("second"));
        }
      },
    });

    coalescer.handle("agent-1", assistant("first"));
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "first" },
        provider: "codex",
      },
    ]);

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "first" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "second" },
        provider: "codex",
      },
    ]);
  });

  test("manual flush prevents late duplicate output after timers advance", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("manual"));
    coalescer.flushFor("agent-1");

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "manual" },
        provider: "codex",
      },
    ]);
  });

  test("flushAndDiscard flushes, clears timer, and invalidates stale callbacks", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("durable"));
    coalescer.flushAndDiscard("agent-1");

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "durable" },
        provider: "codex",
      },
    ]);
  });

  test("stale timers cannot flush reused agent ids", () => {
    const scheduled: Array<() => void> = [];
    const flushes: AgentStreamCoalescerFlush[] = [];
    const setTimeoutShim: AgentStreamCoalescerTimers["setTimeout"] = (callback, delay, ...args) => {
      if (typeof callback === "function") {
        scheduled.push(() => {
          callback(...args);
        });
      }
      return setTimeout(callback, delay, ...args);
    };
    const coalescer = new AgentStreamCoalescer({
      timers: {
        setTimeout: setTimeoutShim,
        clearTimeout,
      },
      onFlush: (payload) => {
        flushes.push(payload);
      },
    });

    coalescer.handle("agent-1", assistant("old"));
    const oldTimerCallback = scheduled[0];
    coalescer.flushAndDiscard("agent-1");
    coalescer.handle("agent-1", assistant("new"));

    oldTimerCallback();
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "old" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "new" },
        provider: "codex",
      },
    ]);
  });

  test("preserves first chunk item shape and replaces only text on collapse", async () => {
    const { coalescer, flushes } = createHarness();
    const firstItem = {
      type: "assistant_message" as const,
      text: "he",
      futureOptionalField: { preserved: true },
    };

    coalescer.handle("agent-1", timeline(firstItem));
    coalescer.handle("agent-1", assistant("llo"));

    await vi.advanceTimersByTimeAsync(33);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "assistant_message",
          text: "hello",
          futureOptionalField: { preserved: true },
        },
        provider: "codex",
      },
    ]);
  });
});
