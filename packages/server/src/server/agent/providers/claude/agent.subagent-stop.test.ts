import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { ClaudeQueryInput } from "./query.js";
import { ClaudeAgentClient } from "./agent.js";

/**
 * Stopping one background subagent without touching its parent turn.
 *
 * This is the consumer half of Claude's `perTaskStopAffordance` bargain. The CLI only spares
 * running background subagents from a turn interrupt while the client can stop them one at a
 * time, and it fails CLOSED without that declaration — so both halves are asserted here. Drop
 * either and pressing Stop silently kills every background child again, which is the regression
 * these tests exist to catch.
 */

const TASK_ID = "aa482d02957fe96c8";
const SUBAGENT_ID = "toolu_01TVF5JXom1yoZVoiaEWAoUV";

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
    stopTask: vi.fn(async (_taskId: string) => undefined),
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

describe("stopping a provider subagent", () => {
  const queryFactory = vi.fn();

  afterEach(() => {
    queryFactory.mockReset();
  });

  async function startTurnWithSubagent(isBackgrounded?: boolean, clientsCanStop = true) {
    const channels: ReturnType<typeof buildOpenQueryMock>[] = [];
    let capturedOptions: ClaudeQueryInput["options"] | null = null;
    let canStop = clientsCanStop;
    queryFactory.mockImplementation(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      const channel = buildOpenQueryMock();
      channels.push(channel);
      return channel.query;
    });
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    }).createSession(
      { provider: "claude", cwd: process.cwd() },
      {
        // The daemon-side view of the attached clients, re-read at every query creation. An older
        // app connected to this daemon answers false, and the affordance must be withheld.
        clientsCanStopProviderSubagents: () => canStop,
      },
    );

    const subagentEvents: unknown[] = [];
    session.subscribe((event) => {
      if (event.type === "provider_subagent") subagentEvents.push(event.event);
    });

    await session.startTurn("delegate work");
    const channel = channels[0]!;
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
      ...(isBackgrounded === undefined ? {} : { is_backgrounded: isBackgrounded }),
    });
    // Wait for the DECLARATION, not merely for the query to exist: startTurn resolves before the
    // pushed task_started has been consumed, and interrupting in that window tests nothing.
    await vi.waitFor(() =>
      expect(subagentEvents).toContainEqual(expect.objectContaining({ id: SUBAGENT_ID })),
    );
    return {
      channel,
      channels,
      session,
      subagentEvents,
      getOptions: () => capturedOptions,
      setClientsCanStop: (value: boolean) => {
        canStop = value;
      },
    };
  }

  test("declares perTaskStopAffordance, so an interrupt spares background subagents", async () => {
    const { session, getOptions } = await startTurnWithSubagent();

    // Without this flag the CLI fails closed and an interrupt kills every background child. It is
    // the entire fix; assert the wire value rather than any local bookkeeping.
    expect(getOptions()?.perTaskStopAffordance).toBe(true);

    await session.close();
  });

  test("withholds the affordance while any attached client cannot stop a subagent", async () => {
    const { session, getOptions } = await startTurnWithSubagent(undefined, false);

    // An older app on this daemon has no per-subagent Stop control. Declaring the affordance
    // anyway would spare a background child that only archiving the parent could stop. Withheld,
    // not sent as false: an option the CLI never knew is indistinguishable from absence.
    expect(getOptions()?.perTaskStopAffordance).toBeUndefined();

    await session.close();
  });

  test("re-reads the client view when the query is (re)created", async () => {
    const { channel, channels, session, getOptions, setClientsCanStop } =
      await startTurnWithSubagent(true, false);
    expect(getOptions()?.perTaskStopAffordance).toBeUndefined();

    // The option is fixed for a CLI query's lifetime, so the re-read point is query creation.
    // End the turn, flip the view (the incapable client disconnected), and force a query
    // restart the way a real one happens — a settings change applies to the next query.
    const turnEvents: string[] = [];
    session.subscribe((event) => {
      if (event.type === "turn_completed" || event.type === "turn_failed") {
        turnEvents.push(event.type);
      }
    });
    channel.push({ type: "result", subtype: "success" });
    await vi.waitFor(() => expect(turnEvents).toContain("turn_completed"));

    setClientsCanStop(true);
    await session.setThinkingOption("high");
    await session.startTurn("more work");
    await vi.waitFor(() => expect(getOptions()?.perTaskStopAffordance).toBe(true));
    expect(channels).toHaveLength(2);

    await session.close();
  });

  test("addresses the provider's task id, not the subagent id", async () => {
    const { channel, session } = await startTurnWithSubagent();

    expect(await session.stopProviderSubagent?.(SUBAGENT_ID)).toBe(true);

    // stop_task takes a task id. Passing the subagent id through would stop nothing, or — worse —
    // whatever unrelated task now holds that string.
    expect(channel.query.stopTask).toHaveBeenCalledWith(TASK_ID);

    await session.close();
  });

  test("refuses an id it cannot vouch for instead of stopping something else", async () => {
    const { channel, session } = await startTurnWithSubagent();

    // Never declared.
    expect(await session.stopProviderSubagent?.("toolu_never_declared")).toBe(false);
    // A task id is not a subagent id, even though this one is live.
    expect(await session.stopProviderSubagent?.(TASK_ID)).toBe(false);
    expect(channel.query.stopTask).not.toHaveBeenCalled();

    await session.close();
  });

  test("refuses a subagent that already settled", async () => {
    const { channel, session, subagentEvents } = await startTurnWithSubagent();

    channel.push({
      type: "system",
      subtype: "task_notification",
      task_id: TASK_ID,
      tool_use_id: SUBAGENT_ID,
      status: "completed",
      usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
    });
    // Wait for the completion to be OBSERVED before asking. Retrying the call itself inside
    // waitFor would send a real stop on the first attempt and then pass on a later one.
    await vi.waitFor(() =>
      expect(subagentEvents).toContainEqual(
        expect.objectContaining({ id: SUBAGENT_ID, status: "completed" }),
      ),
    );

    expect(await session.stopProviderSubagent?.(SUBAGENT_ID)).toBe(false);
    expect(channel.query.stopTask).not.toHaveBeenCalled();

    await session.close();
  });
  test("a child backgrounded at task_started survives an interrupt and stays stoppable", async () => {
    // The original defect. `run_in_background` is announced on task_started
    // (SDKTaskStartedMessage.is_backgrounded) and never re-announced as a task_updated patch, so a
    // source that reads only the patch calls this child foreground, terminalizes it on interrupt,
    // and then refuses to stop it -- while the CLI, because perTaskStopAffordance is declared,
    // actually kept it running. That combination is worse than the bug it replaced: the subagent is
    // alive and unstoppable.
    const { channel, session } = await startTurnWithSubagent(true);

    await session.interrupt();

    expect(await session.stopProviderSubagent?.(SUBAGENT_ID)).toBe(true);
    expect(channel.query.stopTask).toHaveBeenCalledWith(TASK_ID);

    await session.close();
  });

  test("a foreground child is still terminalized by an interrupt", async () => {
    // The complement, so the fix above cannot be "treat everything as backgrounded".
    const { channel, session } = await startTurnWithSubagent(false);

    await session.interrupt();

    expect(await session.stopProviderSubagent?.(SUBAGENT_ID)).toBe(false);
    expect(channel.query.stopTask).not.toHaveBeenCalled();

    await session.close();
  });

  test("a rejected stop is reported as a failure, not as success", async () => {
    const { channel, session } = await startTurnWithSubagent(true);
    channel.query.stopTask.mockRejectedValueOnce(new Error("transport closed"));

    // Must not resolve true: the caller reports this to a user, and the subagent is still running.
    await expect(session.stopProviderSubagent?.(SUBAGENT_ID)).rejects.toThrow(/transport closed/);

    await session.close();
  });
});
