import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";

const queryFactory = vi.fn();

/** A live Claude process: after the scripted frames it stays open instead of exiting. */
function buildLiveQueryMock(events: unknown[]) {
  let index = 0;
  let release: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    next: vi.fn(async () => {
      if (index < events.length) {
        const value = events[index];
        index += 1;
        return { done: false, value };
      }
      await closed;
      return { done: true, value: undefined };
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => {
      release?.();
      return { done: true, value: undefined };
    }),
    close: vi.fn(() => release?.()),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

const RESULT = {
  type: "result",
  subtype: "success",
  usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  total_cost_usd: 0,
};
const INIT = {
  type: "system",
  subtype: "init",
  session_id: "idle-session",
  permissionMode: "default",
};
const BACKGROUND_SHELL_STARTED = {
  type: "system",
  subtype: "task_started",
  task_id: "bash-bg-1",
  tool_use_id: "toolu_bash_bg",
  task_type: "local_bash",
  is_backgrounded: true,
  description: "sleep 300",
};

async function runTurn(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamSession(session, "start background work")) {
    events.push(event);
    if (event.type === "turn_completed" || event.type === "turn_failed") break;
  }
  return events;
}

async function createSession(events: unknown[]): Promise<AgentSession> {
  queryFactory.mockImplementation(() => buildLiveQueryMock(events));
  return new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
}

describe("Claude idle eviction guard", () => {
  afterEach(() => {
    queryFactory.mockReset();
  });

  test("a session that never started a process can be released", async () => {
    const session = await createSession([]);
    expect(session.idleBackendEvictionEligible).toBe(true);
    await expect(session.canEvictIdleBackend?.()).resolves.toBe(true);
    await session.close();
  });

  test("retains the process while a background shell it started is still running", async () => {
    const session = await createSession([
      INIT,
      BACKGROUND_SHELL_STARTED,
      RESULT,
      { type: "system", subtype: "session_state_changed", state: "running" },
    ]);
    const events = await runTurn(session);
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    await vi.waitFor(async () => {
      await expect(session.canEvictIdleBackend?.()).resolves.toBe(false);
    });
    await session.close();
  });

  test("releases the process once Claude reports the background work settled", async () => {
    const session = await createSession([
      INIT,
      BACKGROUND_SHELL_STARTED,
      RESULT,
      {
        type: "system",
        subtype: "task_notification",
        task_id: "bash-bg-1",
        tool_use_id: "toolu_bash_bg",
        status: "completed",
        output_file: "",
        summary: "done",
      },
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);
    await runTurn(session);
    await vi.waitFor(async () => {
      await expect(session.canEvictIdleBackend?.()).resolves.toBe(true);
    });
    await session.close();
  });

  test("refuses to prove idleness when Claude never reports session state after a turn", async () => {
    const session = await createSession([INIT, RESULT]);
    await runTurn(session);
    await expect(session.canEvictIdleBackend?.()).rejects.toThrow(/session state/);
    await session.close();
  });

  test("an ephemeral session is not eligible", async () => {
    queryFactory.mockImplementation(() => buildLiveQueryMock([]));
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    }).createSession({ provider: "claude", cwd: process.cwd() }, undefined, {
      persistSession: false,
    });
    expect(session.idleBackendEvictionEligible).toBe(false);
    await session.close();
  });
});
