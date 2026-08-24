import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { ProviderSubagentInputEvent } from "../../provider-subagents/store.js";
import { ClaudeAgentClient } from "./agent.js";

/**
 * A subagent's lifecycle when its turn is interrupted.
 *
 * Task ids are session-scoped, so a turn ending must not forget them: a backgrounded child settles
 * after the interrupt and still needs the descriptor it was declared on. What a turn ending does
 * warrant is terminalizing the children that were running in the foreground, which died with it.
 */

const queryFactory = vi.fn();

/**
 * A query the test feeds one message at a time and never ends, so a turn can be interrupted while
 * the session stays open and keeps streaming — the shape of "background the child, interrupt, keep
 * working" that the whole feature exists for.
 */
function buildOpenQueryMock() {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const settle = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const query = {
    next: vi.fn(async () => {
      for (;;) {
        if (pending.length > 0) return { done: false, value: pending.shift() };
        if (finished) return { done: true, value: undefined };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => {
      finished = true;
      settle();
      return undefined;
    }),
    close: vi.fn(() => {
      finished = true;
      settle();
    }),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return {
    query,
    push(message: unknown) {
      pending.push(message);
      settle();
    },
  };
}

const TASK_ID = "aa482d02957fe96c8";
const SUBAGENT_ID = "toolu_01TVF5JXom1yoZVoiaEWAoUV";
const SECOND_SUBAGENT_ID = "toolu_01SyncMarker";

describe("subagent lifecycle across an interrupt", () => {
  afterEach(() => {
    queryFactory.mockReset();
  });

  async function startInterruptibleTurn() {
    const channel = buildOpenQueryMock();
    queryFactory.mockImplementation(() => channel.query);
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    }).createSession({ provider: "claude", cwd: process.cwd() });

    const subagentEvents: ProviderSubagentInputEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "provider_subagent") subagentEvents.push(event.event);
    });

    await session.startTurn("delegate work");
    channel.push({
      type: "system",
      subtype: "init",
      session_id: "bg-session",
      permissionMode: "default",
    });
    channel.push({
      type: "system",
      subtype: "task_started",
      task_id: TASK_ID,
      tool_use_id: SUBAGENT_ID,
      task_type: "local_agent",
      subagent_type: "general-purpose",
      description: "Reply with banana",
    });
    await vi.waitFor(() => expect(subagentEvents.length).toBeGreaterThan(0));

    return { channel, session, subagentEvents };
  }

  function statuses(events: ProviderSubagentInputEvent[], id: string): string[] {
    return events.flatMap((event) =>
      event.type === "upsert" && event.id === id && event.status ? [event.status] : [],
    );
  }

  test("a backgrounded child settles after the turn that spawned it is canceled", async () => {
    const { channel, session, subagentEvents } = await startInterruptibleTurn();

    channel.push({
      type: "system",
      subtype: "task_updated",
      task_id: TASK_ID,
      patch: { is_backgrounded: true },
    });
    // Backgrounding is a silent patch — nothing observable follows from it alone. The stream is
    // ordered, so declaring a second subagent behind it and waiting for that declaration proves
    // the patch was consumed.
    channel.push({
      type: "system",
      subtype: "task_started",
      task_id: "second-task",
      tool_use_id: SECOND_SUBAGENT_ID,
      task_type: "local_agent",
      subagent_type: "general-purpose",
      description: "Sync marker",
    });
    await vi.waitFor(() =>
      expect(subagentEvents).toContainEqual(expect.objectContaining({ id: SECOND_SUBAGENT_ID })),
    );

    await session.interrupt();

    // The child was told to outlive the turn, so cancellation says nothing about it...
    channel.push({
      type: "system",
      subtype: "task_notification",
      task_id: TASK_ID,
      tool_use_id: SUBAGENT_ID,
      status: "completed",
      usage: { total_tokens: 32271, tool_uses: 2, duration_ms: 10934 },
    });

    // ...and its completion still routes, because the interrupt did not wipe the task table.
    await vi.waitFor(() =>
      expect(subagentEvents).toContainEqual(
        expect.objectContaining({ id: SUBAGENT_ID, status: "completed" }),
      ),
    );
    expect(statuses(subagentEvents, SUBAGENT_ID)).toEqual(["running", "completed"]);
    // The sibling stayed in the foreground, so it died with the turn.
    expect(statuses(subagentEvents, SECOND_SUBAGENT_ID)).toEqual(["running", "canceled"]);

    await session.close();
  });

  test("a foreground child is canceled with the turn that spawned it", async () => {
    const { session, subagentEvents } = await startInterruptibleTurn();

    await session.interrupt();

    await vi.waitFor(() =>
      expect(statuses(subagentEvents, SUBAGENT_ID)).toEqual(["running", "canceled"]),
    );

    await session.close();
  });
});
