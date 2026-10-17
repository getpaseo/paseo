import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

type QueryMock = Query & { stopTask: ReturnType<typeof vi.fn> };

// Holds the query open after the scripted events, the way a real one stays open between turns.
// Resolving `tail` with a value delivers one more event.
function createQueryMock(events: unknown[], tail: Promise<unknown>): QueryMock {
  let index = 0;
  let pendingTail: Promise<unknown> | undefined = tail;
  return {
    next: vi.fn(async () => {
      if (index < events.length) {
        return { done: false, value: events[index++] };
      }
      const late = await pendingTail;
      pendingTail = new Promise<never>(() => undefined);
      return { done: false, value: late };
    }),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    stopTask: vi.fn(async () => undefined),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as QueryMock;
}

function createChildProcessStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.kill = (() => {
    child.emit("exit", null, "SIGTERM");
    return true;
  }) as ChildProcess["kill"];
  return child;
}

const SHELL_TASK = {
  task_id: "b1kxzuieg",
  run_id: "0mv6i61sl-c945893d",
  task_type: "local_bash",
  description: "Run ctest",
};

// Recorded from Claude Code 2.1.296: the frame lands mid-turn, right after the Bash tool call.
const BACKGROUND_SHELL_TURN_EVENTS = [
  {
    type: "system",
    subtype: "init",
    session_id: "claude-background-tasks-session",
    permissionMode: "default",
    model: "opus",
  },
  { type: "system", subtype: "background_tasks_changed", tasks: [SHELL_TASK] },
  { type: "assistant", message: { content: "Started ctest in the background." } },
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
  },
];

const SPAWN_OPTIONS: ClaudeSpawnOptions = {
  command: "node",
  args: ["claude.js"],
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
};

function backgroundTaskEvents(events: AgentStreamEvent[]) {
  return events.filter((event) => event.type === "background_tasks_changed");
}

async function createBackgroundShellSession(tail: Promise<unknown>) {
  let capturedOptions: Options | undefined;
  let query: QueryMock | undefined;
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    capturedOptions = options;
    query = createQueryMock(BACKGROUND_SHELL_TURN_EVENTS, tail);
    return query;
  });
  const child = createChildProcessStub();
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.run("run ctest in the background");
  capturedOptions?.spawnClaudeCodeProcess?.(SPAWN_OPTIONS);
  if (!query) {
    throw new Error("Expected the session to open a query");
  }
  return { session, events, child, query };
}

describe("Claude background tasks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reports the background shells that outlive the turn", async () => {
    const { session, events } = await createBackgroundShellSession(
      new Promise<never>(() => undefined),
    );

    try {
      // Reported mid-turn, so the provider stamps the foreground turn id on it.
      expect(backgroundTaskEvents(events)).toEqual([
        expect.objectContaining({
          type: "background_tasks_changed",
          provider: "claude",
          tasks: [{ id: "b1kxzuieg", type: "local_bash", description: "Run ctest" }],
        }),
      ]);
    } finally {
      await session.close();
    }
  });

  test("reports a finished shell without opening a turn", async () => {
    let deliver: ((event: unknown) => void) | undefined;
    const { session, events } = await createBackgroundShellSession(
      new Promise<unknown>((resolve) => {
        deliver = resolve;
      }),
    );

    try {
      const turnEventsBefore = events.filter((event) => event.type === "turn_started").length;
      deliver?.({ type: "system", subtype: "background_tasks_changed", tasks: [] });

      await vi.waitFor(() => expect(backgroundTaskEvents(events).at(-1)?.tasks).toEqual([]));
      expect(events.filter((event) => event.type === "turn_started")).toHaveLength(
        turnEventsBefore,
      );
    } finally {
      await session.close();
    }
  });

  test("clears the reported shells when the idle runtime dies", async () => {
    const { session, events, child } = await createBackgroundShellSession(
      new Promise<never>(() => undefined),
    );

    try {
      child.emit("exit", 1, null);

      expect(backgroundTaskEvents(events).at(-1)).toEqual({
        type: "background_tasks_changed",
        provider: "claude",
        tasks: [],
      });
    } finally {
      await session.close();
    }
  });

  test("does not open a turn for the notification that answers a stop", async () => {
    let deliver: ((event: unknown) => void) | undefined;
    const { session, events, query } = await createBackgroundShellSession(
      new Promise<unknown>((resolve) => {
        deliver = resolve;
      }),
    );

    try {
      const turnEventsBefore = events.filter((event) => event.type === "turn_started").length;
      await session.stopBackgroundTask?.("b1kxzuieg");
      deliver?.({
        type: "system",
        subtype: "task_notification",
        task_id: "b1kxzuieg",
        tool_use_id: "toolu_bash",
        status: "stopped",
        output_file: "/tmp/b1kxzuieg.output",
        summary: "Background command stopped",
      });

      // The pump asks for the next frame only after it has routed the delivered one.
      await vi.waitFor(() =>
        expect(query.next).toHaveBeenCalledTimes(BACKGROUND_SHELL_TURN_EVENTS.length + 2),
      );
      expect(events.filter((event) => event.type === "turn_started")).toHaveLength(
        turnEventsBefore,
      );
    } finally {
      await session.close();
    }
  });

  test("stops one background task through the live query", async () => {
    const { session, query } = await createBackgroundShellSession(
      new Promise<never>(() => undefined),
    );

    try {
      await session.stopBackgroundTask?.("b1kxzuieg");

      expect(query.stopTask).toHaveBeenCalledWith("b1kxzuieg");
    } finally {
      await session.close();
    }
  });
});
