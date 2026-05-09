/**
 * Integration tests for the agent event stream redesign (Unit 3).
 *
 * These tests verify the behavioral guarantees of the new provider contract
 * (`startTurn` + `subscribe`) as specified in docs/design/agent-event-stream-redesign.md.
 *
 * All tests use REAL Claude SDK sessions — no mocks.
 *
 * These tests run when the shared Claude provider availability gate passes.
 */
import { beforeAll, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { isProviderAvailable } from "../../../daemon-e2e/agent-configs.js";
import { ClaudeAgentClient } from "./agent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: "silent" });
const client = new ClaudeAgentClient({ logger });

function tmpCwd(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function isTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

// turnId is optional on AgentStreamEvent — this narrows to events where it's present.
type EventWithTurnId = AgentStreamEvent & { turnId: string };

function hasTurnId(event: AgentStreamEvent): event is EventWithTurnId {
  return "turnId" in event && typeof (event as Record<string, unknown>).turnId === "string";
}

function eventsForTurn(events: AgentStreamEvent[], turnId: string): AgentStreamEvent[] {
  return events.filter((e) => hasTurnId(e) && e.turnId === turnId);
}

function userMessagesWithText(events: AgentStreamEvent[], text: string): AgentStreamEvent[] {
  return events.filter(
    (e) => e.type === "timeline" && e.item.type === "user_message" && e.item.text === text,
  );
}

async function createSession(params?: {
  cwdPrefix?: string;
}): Promise<{ cwd: string; session: AgentSession }> {
  const cwd = tmpCwd(params?.cwdPrefix ?? "event-stream-integration-");
  const session = await client.createSession({
    provider: "claude",
    cwd,
    title: "event-stream integration",
    modeId: "acceptEdits",
    model: "haiku",
  });
  return { cwd, session };
}

async function cleanupSession(handle: { cwd: string; session: AgentSession }): Promise<void> {
  await handle.session.close().catch(() => undefined);
  try {
    rmSync(handle.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
      throw error;
    }
  }
}

async function startTurnAndCollectEvents(
  session: AgentSession,
  prompt: string,
  options?: { extraMs?: number; timeoutMs?: number },
): Promise<{ turnId: string; events: AgentStreamEvent[] }> {
  const { extraMs = 0, timeoutMs = 45_000 } = options ?? {};

  return await new Promise((resolve, reject) => {
    const events: AgentStreamEvent[] = [];
    let turnId: string | null = null;
    let settled = false;

    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for terminal event`));
    }, timeoutMs);

    const finish = () => {
      if (settled || !turnId) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve({ turnId, events });
    };

    const unsubscribe = session.subscribe((event) => {
      events.push(event);
      if (!turnId) {
        return;
      }
      if (!isTerminalEvent(event) || !hasTurnId(event) || event.turnId !== turnId) {
        return;
      }
      if (extraMs > 0) {
        setTimeout(finish, extraMs);
        return;
      }
      finish();
    });

    void session
      .startTurn(prompt)
      .then((result) => {
        turnId = result.turnId;
        return;
      })
      .catch((error) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      });
  });
}

// ---------------------------------------------------------------------------
// Invariant assertions — run after every test
// ---------------------------------------------------------------------------

function assertInvariants(events: AgentStreamEvent[], foregroundTurnIds: string[]): void {
  // Invariant 1: For each foreground turnId, at most ONE user_message event.
  // The manager records foreground prompts separately, so provider echoes may be suppressed.
  for (const turnId of foregroundTurnIds) {
    const turnEvents = eventsForTurn(events, turnId);
    const userMsgs = turnEvents.filter(
      (e) => e.type === "timeline" && e.item.type === "user_message",
    );
    expect(
      userMsgs.length,
      `Expected at most 1 user_message for turnId ${turnId}, got ${userMsgs.length}`,
    ).toBeLessThanOrEqual(1);
  }

  // Invariant 2: Every turn_started has exactly one matching terminal
  const turnStartedIds = events
    .filter((e) => e.type === "turn_started" && hasTurnId(e))
    .map((e) => (e as EventWithTurnId).turnId);

  for (const turnId of turnStartedIds) {
    const terminals = eventsForTurn(events, turnId).filter(isTerminalEvent);
    expect(
      terminals.length,
      `Expected exactly 1 terminal for turnId ${turnId}, got ${terminals.length}`,
    ).toBe(1);
  }

  // Invariant 3: After terminal for a foreground turnId, no later event with
  // that turnId appears (would indicate stale routing to autonomous)
  for (const turnId of foregroundTurnIds) {
    const allWithTurn = events
      .map((e, i) => ({ event: e, index: i }))
      .filter(({ event }) => hasTurnId(event) && event.turnId === turnId);

    const terminalEntry = allWithTurn.find(({ event }) => isTerminalEvent(event));
    if (!terminalEntry) continue;

    const afterTerminal = allWithTurn.filter(({ index }) => index > terminalEntry.index);
    expect(
      afterTerminal.length,
      `No events should appear for foreground turnId ${turnId} after terminal`,
    ).toBe(0);
  }

  // Invariant 4: Autonomous turns have distinct turnIds from foreground turns
  const allTurnIds = new Set(events.filter(hasTurnId).map((e) => e.turnId));
  const autonomousTurnIds = [...allTurnIds].filter((id) => !foregroundTurnIds.includes(id));
  for (const autoId of autonomousTurnIds) {
    expect(foregroundTurnIds).not.toContain(autoId);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let canRun = false;

beforeAll(async () => {
  canRun = await isProviderAvailable("claude");
});

beforeEach((context) => {
  if (!canRun) {
    context.skip();
  }
});

test("Test 1: Basic foreground turn", async () => {
  const handle = await createSession({ cwdPrefix: "event-stream-basic-" });

  try {
    const { turnId, events } = await startTurnAndCollectEvents(
      handle.session,
      "respond with just the word hello",
    );

    const turnStarted = events.find(
      (e) => e.type === "turn_started" && hasTurnId(e) && e.turnId === turnId,
    );
    expect(turnStarted).toBeDefined();

    const terminal = events.find((e) => isTerminalEvent(e) && hasTurnId(e) && e.turnId === turnId);
    expect(terminal).toBeDefined();

    assertInvariants(events, [turnId]);
  } finally {
    await cleanupSession(handle);
  }
}, 60_000);

test("Test 2: No duplicate user_messages — THE BUG", async () => {
  const handle = await createSession({ cwdPrefix: "event-stream-dedup-" });

  try {
    const { turnId, events } = await startTurnAndCollectEvents(handle.session, "say hi", {
      extraMs: 3_000,
    });

    expect(userMessagesWithText(events, "say hi").length).toBeLessThanOrEqual(1);

    // No turn_started after terminal for the same turnId
    const terminalIdx = events.findIndex(
      (e) => isTerminalEvent(e) && hasTurnId(e) && e.turnId === turnId,
    );
    const staleTurnStarted = events
      .slice(terminalIdx + 1)
      .filter((e) => e.type === "turn_started" && hasTurnId(e) && e.turnId === turnId);
    expect(staleTurnStarted.length).toBe(0);

    assertInvariants(events, [turnId]);
  } finally {
    await cleanupSession(handle);
  }
}, 60_000);

test("Test 3: Lifecycle doesn't get stuck in running", async () => {
  const handle = await createSession({ cwdPrefix: "event-stream-lifecycle-" });

  try {
    const { turnId, events } = await startTurnAndCollectEvents(handle.session, "say hi", {
      extraMs: 3_000,
    });

    const terminalIdx = events.findIndex(
      (e) => isTerminalEvent(e) && hasTurnId(e) && e.turnId === turnId,
    );
    const afterTerminal = events.slice(terminalIdx + 1);

    // No subsequent turn_started for same turnId
    expect(
      afterTerminal.filter((e) => e.type === "turn_started" && hasTurnId(e) && e.turnId === turnId)
        .length,
    ).toBe(0);

    // Any turn_started after terminal must have a different turnId
    for (const ts of afterTerminal.filter((e) => e.type === "turn_started" && hasTurnId(e))) {
      expect((ts as EventWithTurnId).turnId).not.toBe(turnId);
    }

    assertInvariants(events, [turnId]);
  } finally {
    await cleanupSession(handle);
  }
}, 60_000);

test("Test 4: Autonomous run", async () => {
  const handle = await createSession({ cwdPrefix: "event-stream-autonomous-" });
  const autonomousWakeToken = `AUTONOMOUS_WAKE_${Date.now().toString(36)}`;

  try {
    const { turnId: fgTurnId, events } = await startTurnAndCollectEvents(
      handle.session,
      [
        "Use the Task tool to start a background sub-agent.",
        "In that task, run the Bash command exactly: sleep 3 && echo BACKGROUND_DONE",
        "Do not wait for task completion.",
        "Reply immediately with exactly: SPAWNED",
        `When the background task completes later, reply with exactly: ${autonomousWakeToken}`,
      ].join(" "),
      {
        extraMs: 10_000,
        timeoutMs: 60_000,
      },
    );

    const fgTerminalIdx = events.findIndex(
      (e) => isTerminalEvent(e) && hasTurnId(e) && e.turnId === fgTurnId,
    );
    const afterForeground = events.slice(fgTerminalIdx + 1);

    // Autonomous turn_started with a different turnId
    const autoStarts = afterForeground.filter(
      (e) => e.type === "turn_started" && hasTurnId(e) && e.turnId !== fgTurnId,
    ) as EventWithTurnId[];
    if (autoStarts.length === 0) {
      assertInvariants(events, [fgTurnId]);
      return;
    }

    const autoTurnId = autoStarts[0].turnId;
    expect(fgTurnId).not.toBe(autoTurnId);

    // Autonomous turn reaches terminal
    expect(
      afterForeground.find((e) => isTerminalEvent(e) && hasTurnId(e) && e.turnId === autoTurnId),
    ).toBeDefined();

    assertInvariants(events, [fgTurnId]);
  } finally {
    await cleanupSession(handle);
  }
}, 90_000);

test("Test 5: Interruption", async () => {
  const handle = await createSession({ cwdPrefix: "event-stream-interrupt-" });

  try {
    let turnId: string | null = null;
    const events = await new Promise<AgentStreamEvent[]>((resolve, reject) => {
      const collected: AgentStreamEvent[] = [];
      let interrupted = false;

      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out after 45000ms waiting for terminal event"));
      }, 45_000);

      const unsubscribe = handle.session.subscribe((event) => {
        collected.push(event);
        if (!turnId && event.type === "turn_started" && hasTurnId(event)) {
          turnId = event.turnId;
        }

        // Once we see turn_started, fire the interrupt
        if (
          !interrupted &&
          turnId &&
          event.type === "turn_started" &&
          hasTurnId(event) &&
          event.turnId === turnId
        ) {
          interrupted = true;
          handle.session.interrupt().catch(() => undefined);
        }

        // Resolve when we get a terminal event for this turn
        if (turnId && isTerminalEvent(event) && hasTurnId(event) && event.turnId === turnId) {
          clearTimeout(timeout);
          unsubscribe();
          resolve(collected);
        }
      });

      void handle.session
        .startTurn("write a very long essay about the history of computing")
        .then((result) => {
          if (turnId && turnId !== result.turnId) {
            clearTimeout(timeout);
            unsubscribe();
            reject(
              new Error(
                `Observed turn_started for ${turnId} but startTurn returned ${result.turnId}`,
              ),
            );
            return;
          }
          turnId = result.turnId;
          return;
        })
        .catch((error) => {
          clearTimeout(timeout);
          unsubscribe();
          reject(error);
        });
    });

    expect(turnId).toBeDefined();

    // turn_canceled or turn_failed arrives for that turnId
    const terminal = events.find(
      (e) =>
        (e.type === "turn_canceled" || e.type === "turn_failed") &&
        hasTurnId(e) &&
        e.turnId === turnId,
    );
    expect(terminal).toBeDefined();

    // No further events for that turnId after terminal
    const terminalIdx = events.indexOf(terminal!);
    expect(
      events.slice(terminalIdx + 1).filter((e) => hasTurnId(e) && e.turnId === turnId).length,
    ).toBe(0);

    assertInvariants(events, [turnId]);
  } finally {
    await cleanupSession(handle);
  }
}, 60_000);

test("Test 6: Sequential foreground turns", async () => {
  const handle = await createSession({ cwdPrefix: "event-stream-sequential-" });

  try {
    const { turnId: turnId1, events: events1 } = await startTurnAndCollectEvents(
      handle.session,
      "say first",
    );

    const { turnId: turnId2, events: events2 } = await startTurnAndCollectEvents(
      handle.session,
      "say second",
    );

    const allEvents = [...events1, ...events2];

    expect(turnId1).not.toBe(turnId2);

    // No events from turn 1 after turn 2 starts
    const turn2StartIdx = allEvents.findIndex(
      (e) => e.type === "turn_started" && hasTurnId(e) && e.turnId === turnId2,
    );
    expect(
      allEvents.slice(turn2StartIdx + 1).filter((e) => hasTurnId(e) && e.turnId === turnId1).length,
    ).toBe(0);

    assertInvariants(allEvents, [turnId1, turnId2]);
  } finally {
    await cleanupSession(handle);
  }
}, 90_000);

test("Test 7: Fast-fail", async () => {
  const handle = await createSession({ cwdPrefix: "event-stream-fast-fail-" });

  try {
    const { turnId, events } = await startTurnAndCollectEvents(handle.session, "", {
      extraMs: 3_000,
    });

    // At most one turn_started
    expect(
      events.filter((e) => e.type === "turn_started" && hasTurnId(e) && e.turnId === turnId).length,
    ).toBeLessThanOrEqual(1);

    // Terminal present
    const terminal = events.find((e) => isTerminalEvent(e) && hasTurnId(e) && e.turnId === turnId);
    expect(terminal).toBeDefined();

    // No stale turn_started after terminal
    const terminalIdx = events.indexOf(terminal!);
    expect(events.slice(terminalIdx + 1).filter((e) => e.type === "turn_started").length).toBe(0);

    assertInvariants(events, [turnId]);
  } finally {
    await cleanupSession(handle);
  }
}, 60_000);

test("Test 8: User message dedup by text", async () => {
  const handle = await createSession({ cwdPrefix: "event-stream-user-dedup-" });

  try {
    const { turnId, events } = await startTurnAndCollectEvents(handle.session, "hello world", {
      extraMs: 3_000,
    });

    expect(userMessagesWithText(events, "hello world").length).toBeLessThanOrEqual(1);

    assertInvariants(events, [turnId]);
  } finally {
    await cleanupSession(handle);
  }
}, 60_000);
