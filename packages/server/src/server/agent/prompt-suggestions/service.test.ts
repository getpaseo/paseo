import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPromptSuggestionsMessage } from "@getpaseo/protocol/messages";
import type { AgentManagerEvent, AgentSubscriber } from "../agent-manager.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";
import { PromptSuggestionService } from "./service.js";

interface FakeAgent {
  id: string;
  cwd: string;
  internal?: boolean;
  provider?: string;
  config: { title?: string; model?: string };
}

const TIMELINE: AgentTimelineItem[] = [
  { type: "user_message", text: "fix the login test" },
  { type: "assistant_message", text: "auth.test.ts now passes" },
];

function streamEvent(agentId: string, type: AgentStreamEvent["type"]): AgentManagerEvent {
  return {
    type: "agent_stream",
    agentId,
    event: { type, provider: "claude", reason: "user" } as AgentStreamEvent,
  } as AgentManagerEvent;
}

function createHarness(
  overrides: {
    agents?: Record<string, FakeAgent>;
    enabled?: boolean;
    hasListeners?: () => boolean;
    maxConcurrent?: number;
  } = {},
) {
  const agents: Record<string, FakeAgent> = overrides.agents ?? {
    a1: { id: "a1", cwd: "/repo", config: { title: "Login fix" } },
  };
  let subscriber: AgentSubscriber | null = null;
  const emitted: AgentPromptSuggestionsMessage[] = [];
  const pending: Array<{
    resolve: (value: { suggestions: string[] }) => void;
    reject: (error: Error) => void;
    prompt: string;
    cwd: string;
    currentSelection?: { provider?: string | null; model?: string | null };
  }> = [];

  const service = new PromptSuggestionService({
    agents: {
      subscribe: ((callback: AgentSubscriber) => {
        subscriber = callback;
        return () => {
          subscriber = null;
        };
      }) as never,
      getAgent: ((id: string) => (agents[id] ?? null) as never) as never,
      getTimeline: (() => TIMELINE) as never,
    },
    generation: {
      generate: ({ prompt, cwd, currentSelection }) =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject, prompt, cwd, currentSelection });
        }),
    },
    emit: (message) => emitted.push(message),
    isEnabled: () => overrides.enabled ?? true,
    hasListeners: overrides.hasListeners,
    maxConcurrent: overrides.maxConcurrent,
    logger: { debug: () => undefined },
    debounceMs: 400,
    now: () => new Date("2026-09-18T10:00:00.000Z"),
  });
  service.start();

  return {
    service,
    emitted,
    pending,
    emitStream(agentId: string, type: AgentStreamEvent["type"]) {
      subscriber?.(streamEvent(agentId, type));
    },
  };
}

describe("PromptSuggestionService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates and emits after a completed turn", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    expect(harness.pending).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(400);
    expect(harness.pending).toHaveLength(1);
    expect(harness.pending[0].cwd).toBe("/repo");
    expect(harness.pending[0].prompt).toContain("[User] fix the login test");

    harness.pending[0].resolve({
      suggestions: ["open a PR", "run the full suite"],
    });
    await vi.runAllTimersAsync();

    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0].payload).toMatchObject({
      agentId: "a1",
      suggestions: [
        { id: "s1", text: "open a PR" },
        { id: "s2", text: "run the full suite" },
      ],
      generatedAt: "2026-09-18T10:00:00.000Z",
    });
  });

  it("generates on request for a chat opened with nothing cached", async () => {
    const harness = createHarness();

    expect(harness.service.requestFor("a1")).toEqual({ accepted: true });
    await vi.runAllTimersAsync();
    expect(harness.pending).toHaveLength(1);

    harness.pending[0].resolve({ suggestions: ["open a PR"] });
    await vi.runAllTimersAsync();
    expect(harness.emitted).toHaveLength(1);
  });

  it("re-emits the cached suggestion instead of generating twice", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);
    harness.pending[0].resolve({ suggestions: ["open a PR"] });
    await vi.runAllTimersAsync();

    expect(harness.service.requestFor("a1")).toEqual({ accepted: true });
    await vi.runAllTimersAsync();

    expect(harness.pending).toHaveLength(1);
    expect(harness.emitted).toHaveLength(2);
    expect(harness.emitted[1].payload).toEqual(harness.emitted[0].payload);
  });

  it("declines a request while the host has the feature off", () => {
    const harness = createHarness({ enabled: false });

    expect(harness.service.requestFor("a1").accepted).toBe(false);
    expect(harness.pending).toHaveLength(0);
  });

  it("declines a request for an unknown agent", () => {
    const harness = createHarness();

    expect(harness.service.requestFor("nope").accepted).toBe(false);
    expect(harness.pending).toHaveLength(0);
  });

  it("drops the cache when a new turn starts", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);
    harness.pending[0].resolve({ suggestions: ["open a PR"] });
    await vi.runAllTimersAsync();

    harness.emitStream("a1", "turn_started");
    expect(harness.service.requestFor("a1")).toEqual({ accepted: true });
    await vi.runAllTimersAsync();

    expect(harness.pending).toHaveLength(2);
  });

  // Without it, a machine whose metadata chain has no usable model never gets a
  // suggestion, even though the agent's own model is working.
  it("offers the agent's own model as the last resort", async () => {
    const harness = createHarness({
      agents: {
        a1: {
          id: "a1",
          cwd: "/repo",
          provider: "codex",
          config: { title: "t", model: "gpt-6-astra" },
        },
      },
    });

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);

    expect(harness.pending[0].currentSelection).toEqual({
      provider: "codex",
      model: "gpt-6-astra",
    });
  });

  it("debounces a burst of completions into one generation", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(100);
    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(100);
    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);

    expect(harness.pending).toHaveLength(1);
  });

  it("cancels a pending generation when a new turn starts", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(100);
    harness.emitStream("a1", "turn_started");
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.pending).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });

  it("drops a result whose turn was superseded while it was in flight", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);
    expect(harness.pending).toHaveLength(1);

    harness.emitStream("a1", "turn_started");
    harness.pending[0].resolve({ suggestions: ["stale suggestion"] });
    await vi.runAllTimersAsync();

    expect(harness.emitted).toHaveLength(0);
  });

  it("keeps one generation in flight per agent", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);
    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);

    expect(harness.pending).toHaveLength(1);
  });

  it("runs the newer turn after an in-flight generation for the same agent settles", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);
    expect(harness.pending).toHaveLength(1);

    // A second turn completes while the first generation is still in flight.
    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);
    expect(harness.pending).toHaveLength(1);

    harness.pending[0].resolve({ suggestions: ["from the stale turn"] });
    await vi.runAllTimersAsync();

    expect(harness.pending).toHaveLength(2);
    harness.pending[1].resolve({ suggestions: ["from the newest turn"] });
    await vi.runAllTimersAsync();

    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0].payload.suggestions[0].text).toBe("from the newest turn");
  });

  it("caps concurrent generations across agents and drains the queue", async () => {
    const harness = createHarness({
      agents: {
        a1: { id: "a1", cwd: "/repo", config: {} },
        a2: { id: "a2", cwd: "/repo", config: {} },
        a3: { id: "a3", cwd: "/repo", config: {} },
      },
      maxConcurrent: 2,
    });

    harness.emitStream("a1", "turn_completed");
    harness.emitStream("a2", "turn_completed");
    harness.emitStream("a3", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);

    expect(harness.pending).toHaveLength(2);

    harness.pending[0].resolve({ suggestions: ["first"] });
    await vi.runAllTimersAsync();

    expect(harness.pending).toHaveLength(3);
  });

  it("stays silent when generation fails", async () => {
    const harness = createHarness();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(400);
    harness.pending[0].reject(new Error("no provider"));
    await vi.runAllTimersAsync();

    expect(harness.emitted).toHaveLength(0);
  });

  it("skips internal agents, a disabled setting and a daemon with no listeners", async () => {
    const internal = createHarness({
      agents: { a1: { id: "a1", cwd: "/repo", internal: true, config: {} } },
    });
    internal.emitStream("a1", "turn_completed");

    const disabled = createHarness({ enabled: false });
    disabled.emitStream("a1", "turn_completed");

    const unwatched = createHarness({ hasListeners: () => false });
    unwatched.emitStream("a1", "turn_completed");

    await vi.advanceTimersByTimeAsync(1000);

    expect(internal.pending).toHaveLength(0);
    expect(disabled.pending).toHaveLength(0);
    expect(unwatched.pending).toHaveLength(0);
  });

  it("stops listening after stop()", async () => {
    const harness = createHarness();
    harness.service.stop();

    harness.emitStream("a1", "turn_completed");
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.pending).toHaveLength(0);
  });
});
