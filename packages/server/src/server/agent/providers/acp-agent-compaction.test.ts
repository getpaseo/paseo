import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ACPAgentSession } from "./acp-agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";

const COMPACTION_METHOD = "_cognition.ai/compaction";

interface SessionInternals {
  activeForegroundTurnId: string | null;
  turnWaitsForCompaction: boolean;
  compactionInFlight: boolean;
  handlePromptResponse(response: { stopReason: string; usage?: unknown }, turnId: string): void;
}

function createSession() {
  return new ACPAgentSession(
    { provider: "devin", cwd: "/tmp/paseo-acp-test" },
    {
      provider: "devin",
      logger: createTestLogger(),
      defaultCommand: ["devin", "acp"],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    },
  );
}

function collect(session: ACPAgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

function internals(session: ACPAgentSession): SessionInternals {
  return asInternals<SessionInternals>(session);
}

function beginTurn(session: ACPAgentSession, turnId: string, compact = false): SessionInternals {
  const state = internals(session);
  state.activeForegroundTurnId = turnId;
  state.turnWaitsForCompaction = compact;
  return state;
}

function types(events: AgentStreamEvent[]): string[] {
  return events.map((event) =>
    event.type === "timeline" && event.item.type === "compaction"
      ? `compaction:${event.item.status}`
      : event.type,
  );
}

describe("ACP background compaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a plain end_turn still completes the turn", async () => {
    const session = createSession();
    const events = collect(session);
    const state = beginTurn(session, "turn-plain");

    state.handlePromptResponse({ stopReason: "end_turn" }, "turn-plain");
    await vi.advanceTimersByTimeAsync(10);

    expect(types(events)).toEqual(["turn_completed"]);
  });

  test("a /compact end_turn waits for the terminal compaction status", async () => {
    const session = createSession();
    const events = collect(session);
    const state = beginTurn(session, "turn-compact", true);

    state.handlePromptResponse({ stopReason: "end_turn" }, "turn-compact");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(types(events)).toEqual([]);

    await session.extNotification(COMPACTION_METHOD, { status: "started", sessionId: "s" });
    expect(state.compactionInFlight).toBe(true);
    expect(types(events)).toEqual(["compaction:loading"]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(types(events)).toEqual(["compaction:loading"]);

    await session.extNotification(COMPACTION_METHOD, { status: "completed", sessionId: "s" });
    await vi.advanceTimersByTimeAsync(1);

    expect(types(events)).toEqual(["compaction:loading", "compaction:completed", "turn_completed"]);
  });

  test("a failed compaction still releases the turn", async () => {
    const session = createSession();
    const events = collect(session);
    const state = beginTurn(session, "turn-failed", true);

    state.handlePromptResponse({ stopReason: "end_turn" }, "turn-failed");
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await session.extNotification(COMPACTION_METHOD, { status: "failed" });
    await vi.advanceTimersByTimeAsync(1);

    expect(types(events)).toEqual(["compaction:loading", "compaction:completed", "turn_completed"]);
    expect(state.compactionInFlight).toBe(false);
  });

  test("started arriving before the prompt response also holds the turn", async () => {
    const session = createSession();
    const events = collect(session);
    const state = beginTurn(session, "turn-early", true);

    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    state.handlePromptResponse({ stopReason: "end_turn" }, "turn-early");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(types(events)).toEqual(["compaction:loading"]);

    await session.extNotification(COMPACTION_METHOD, { status: "completed" });
    await vi.advanceTimersByTimeAsync(1);
    expect(types(events)).toEqual(["compaction:loading", "compaction:completed", "turn_completed"]);
  });

  test("cancelling the turn wins over a pending compaction", async () => {
    const session = createSession();
    const events = collect(session);
    const state = beginTurn(session, "turn-cancel", true);

    state.handlePromptResponse({ stopReason: "cancelled" }, "turn-cancel");
    await vi.advanceTimersByTimeAsync(1);

    expect(types(events)).toEqual(["turn_canceled"]);
    expect(state.compactionInFlight).toBe(false);
  });

  test("a compaction notification without an active turn is ignored", async () => {
    const session = createSession();
    const events = collect(session);
    const state = internals(session);

    await session.extNotification(COMPACTION_METHOD, { status: "started" });

    expect(state.compactionInFlight).toBe(false);
    expect(events).toEqual([]);
  });

  test("the wait backstop releases the turn when no terminal status arrives", async () => {
    const session = createSession();
    const events = collect(session);
    const state = beginTurn(session, "turn-stuck", true);

    state.handlePromptResponse({ stopReason: "end_turn" }, "turn-stuck");
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await vi.advanceTimersByTimeAsync(13 * 60 * 1_000);

    expect(types(events)).toEqual(["compaction:loading", "turn_completed"]);
    expect(state.compactionInFlight).toBe(false);
  });
});
