import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ACPAgentSession } from "./acp-agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";

const COMPACTION_METHOD = "_cognition.ai/compaction";

type StopReason = "end_turn" | "cancelled" | "refusal";
interface PromptResult {
  stopReason: StopReason;
  usage?: { outputTokens?: number };
}

interface SessionInternals {
  sessionId: string | null;
  connection: unknown;
  compactionInFlight: boolean;
}

interface SessionControls {
  session: ACPAgentSession;
  events: AgentStreamEvent[];
  /** Answer the `session/prompt` request that `startTurn` is waiting on. */
  answer(response: PromptResult): Promise<void>;
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

/**
 * Wires a session the way the ACP transport does — `sessionId` plus a
 * `connection` — so every case below crosses `startTurn`, `extNotification` and
 * `interrupt` instead of poking private fields.
 */
function connect(): SessionControls {
  const session = new ACPAgentSession(
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

  let resolvePrompt: ((response: PromptResult) => void) | null = null;
  const prompt = vi.fn(
    () =>
      new Promise<PromptResult>((resolve) => {
        resolvePrompt = resolve;
      }),
  );
  const cancel = vi.fn(async () => {});
  const internals = asInternals<SessionInternals>(session);
  internals.sessionId = "session-1";
  internals.connection = { prompt, cancel };

  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  return {
    session,
    events,
    prompt,
    cancel,
    answer: async (response) => {
      if (!resolvePrompt) {
        throw new Error("startTurn did not issue a prompt");
      }
      resolvePrompt(response);
      await flushPromises();
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 4; index++) {
    await Promise.resolve();
  }
}

/** Compaction markers and turn outcomes, in emission order. */
function transcript(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "timeline" && event.item.type === "compaction") {
      return [`compaction:${event.item.status}`];
    }
    if (
      event.type === "turn_completed" ||
      event.type === "turn_canceled" ||
      event.type === "turn_failed"
    ) {
      return [event.type];
    }
    return [];
  });
}

function inFlight(session: ACPAgentSession): boolean {
  return asInternals<SessionInternals>(session).compactionInFlight;
}

describe("ACP background compaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a plain turn completes without a timer", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("hello");
    await answer({ stopReason: "end_turn" });

    // No timer has been advanced: a plain end_turn must settle synchronously.
    expect(
      asInternals<{ activeForegroundTurnId: string | null }>(session).activeForegroundTurnId,
    ).toBeNull();
    expect(transcript(events)).toEqual(["turn_completed"]);
  });

  test("compaction notifications around tool rounds are ignored on a plain turn", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("hello");
    // `devin acp` emits a started/completed pair around every tool round even
    // when nothing is being compacted.
    for (let round = 0; round < 3; round++) {
      await session.extNotification(COMPACTION_METHOD, { status: "started" });
      await session.extNotification(COMPACTION_METHOD, { status: "completed" });
    }
    await answer({ stopReason: "end_turn" });

    expect(transcript(events)).toEqual(["turn_completed"]);
    expect(inFlight(session)).toBe(false);
  });

  test("an unanswered started on a plain turn does not hold the turn", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("hello");
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await answer({ stopReason: "end_turn" });

    expect(transcript(events)).toEqual(["turn_completed"]);
    expect(inFlight(session)).toBe(false);
  });

  test("a /compact end_turn waits for the terminal compaction status", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("/compact");
    await answer({ stopReason: "end_turn" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(transcript(events)).toEqual([]);

    await session.extNotification(COMPACTION_METHOD, { status: "started", sessionId: "s" });
    expect(inFlight(session)).toBe(true);
    expect(transcript(events)).toEqual(["compaction:loading"]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(transcript(events)).toEqual(["compaction:loading"]);

    await session.extNotification(COMPACTION_METHOD, { status: "completed", sessionId: "s" });
    await vi.advanceTimersByTimeAsync(1);

    expect(transcript(events)).toEqual([
      "compaction:loading",
      "compaction:completed",
      "turn_completed",
    ]);
  });

  test("repeated started notifications share one loading marker", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("/compact");
    await answer({ stopReason: "end_turn" });
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await session.extNotification(COMPACTION_METHOD, { status: "started" });

    expect(transcript(events)).toEqual(["compaction:loading"]);

    await session.extNotification(COMPACTION_METHOD, { status: "completed" });
    await vi.advanceTimersByTimeAsync(1);

    expect(transcript(events)).toEqual([
      "compaction:loading",
      "compaction:completed",
      "turn_completed",
    ]);
  });

  test("a failed compaction still releases the turn", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("/compact");
    await answer({ stopReason: "end_turn" });
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await session.extNotification(COMPACTION_METHOD, { status: "failed" });
    await vi.advanceTimersByTimeAsync(1);

    expect(transcript(events)).toEqual([
      "compaction:loading",
      "compaction:completed",
      "turn_completed",
    ]);
    expect(inFlight(session)).toBe(false);
  });

  test("started arriving before the prompt response also holds the turn", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("/compact");
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await answer({ stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transcript(events)).toEqual(["compaction:loading"]);

    await session.extNotification(COMPACTION_METHOD, { status: "completed" });
    await vi.advanceTimersByTimeAsync(1);
    expect(transcript(events)).toEqual([
      "compaction:loading",
      "compaction:completed",
      "turn_completed",
    ]);
  });

  test("stopping the turn wins over a pending compaction", async () => {
    const { session, events, answer, cancel } = connect();

    await session.startTurn("/compact");
    await session.interrupt();
    expect(cancel).toHaveBeenCalledOnce();
    await answer({ stopReason: "cancelled" });
    await vi.advanceTimersByTimeAsync(1);

    expect(transcript(events)).toEqual(["turn_canceled"]);
    expect(inFlight(session)).toBe(false);
  });

  test("a compaction notification after the turn ended is ignored", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("/compact");
    await answer({ stopReason: "end_turn" });
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await session.extNotification(COMPACTION_METHOD, { status: "completed" });
    await vi.advanceTimersByTimeAsync(1);
    expect(transcript(events)).toEqual([
      "compaction:loading",
      "compaction:completed",
      "turn_completed",
    ]);

    events.length = 0;
    await session.extNotification(COMPACTION_METHOD, { status: "started" });

    expect(transcript(events)).toEqual([]);
    expect(inFlight(session)).toBe(false);
  });

  test("the wait backstop closes the marker and releases the turn", async () => {
    const { session, events, answer } = connect();

    await session.startTurn("/compact");
    await answer({ stopReason: "end_turn" });
    await session.extNotification(COMPACTION_METHOD, { status: "started" });
    await vi.advanceTimersByTimeAsync(13 * 60 * 1_000);

    expect(transcript(events)).toEqual([
      "compaction:loading",
      "compaction:completed",
      "turn_completed",
    ]);
    expect(inFlight(session)).toBe(false);
  });
});
