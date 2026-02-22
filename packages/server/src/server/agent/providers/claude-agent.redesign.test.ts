import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Logger } from "pino";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { ClaudeAgentClient } from "./claude-agent.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdkMocks.query,
}));

type QueryMock = {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
};

function buildUsage() {
  return {
    input_tokens: 1,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  };
}

function createPromptUuidReader(prompt: AsyncIterable<unknown>) {
  const iterator = prompt[Symbol.asyncIterator]();
  let cached: Promise<string | null> | null = null;
  return async () => {
    if (!cached) {
      cached = iterator.next().then((next) => {
        if (next.done) {
          return null;
        }
        const value = next.value as { uuid?: unknown } | undefined;
        return typeof value?.uuid === "string" ? value.uuid : null;
      });
    }
    return cached;
  };
}

function createBaseQueryMock(nextImpl: QueryMock["next"]): QueryMock {
  return {
    next: nextImpl,
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
  };
}

async function createSession() {
  const client = new ClaudeAgentClient({ logger: createTestLogger() });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
}

function createSessionWithLogger(logger: Logger) {
  const client = new ClaudeAgentClient({ logger });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
}

type CapturedLog = {
  level: "debug" | "info" | "warn" | "error";
  args: unknown[];
};

function createSpyLogger(): {
  logger: Logger;
  calls: CapturedLog[];
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const calls: CapturedLog[] = [];
  const debug = vi.fn((...args: unknown[]) => {
    calls.push({ level: "debug", args });
  });
  const info = vi.fn((...args: unknown[]) => {
    calls.push({ level: "info", args });
  });
  const warn = vi.fn((...args: unknown[]) => {
    calls.push({ level: "warn", args });
  });
  const error = vi.fn((...args: unknown[]) => {
    calls.push({ level: "error", args });
  });

  const loggerLike = {
    child: vi.fn(),
    debug,
    info,
    warn,
    error,
    fatal: error,
    trace: debug,
  };
  loggerLike.child.mockReturnValue(loggerLike);

  return {
    logger: loggerLike as unknown as Logger,
    calls,
    debug,
    info,
    warn,
    error,
  };
}

function extractStringLogArgs(calls: unknown[][]): string[] {
  return calls.flatMap((args) =>
    args.filter((arg): arg is string => typeof arg === "string")
  );
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      break;
    }
  }
  return events;
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

describe("ClaudeAgentSession redesign invariants", () => {
  beforeEach(() => {
    sdkMocks.query.mockReset();
  });

  afterEach(() => {
    sdkMocks.query.mockReset();
  });

  test("logs redacted query summary and never leaks sentinel secrets", async () => {
    const envSecret = "PASEO_ENV_SENTINEL_SECRET";
    const runtimeSecret = "PASEO_RUNTIME_SENTINEL_SECRET";
    const systemSecret = "PASEO_SYSTEM_PROMPT_SENTINEL_SECRET";
    const previousEnv = process.env.PASEO_TEST_SENTINEL_SECRET;
    process.env.PASEO_TEST_SENTINEL_SECRET = envSecret;

    sdkMocks.query.mockImplementation(() => {
      let step = 0;
      return createBaseQueryMock(
        vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "redacted-log-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: { content: "done" },
              },
            };
          }
          if (step === 2) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        })
      );
    });

    const spy = createSpyLogger();
    const client = new ClaudeAgentClient({
      logger: spy.logger,
      runtimeSettings: {
        env: {
          PASEO_RUNTIME_SENTINEL_SECRET: runtimeSecret,
        },
      },
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      systemPrompt: `Never log ${systemSecret}`,
    });

    try {
      await session.run("redaction check");

      const queryLogCall = spy.debug.mock.calls.find(
        (args) => args[1] === "claude query"
      );
      expect(queryLogCall).toBeDefined();
      const payload = queryLogCall?.[0] as
        | { options?: Record<string, unknown> }
        | undefined;
      expect(payload?.options).toBeDefined();
      expect(payload?.options).not.toHaveProperty("env");
      expect(payload?.options).not.toHaveProperty("systemPrompt");
      expect(payload?.options).not.toHaveProperty("canUseTool");
      expect(payload?.options).toHaveProperty("hasEnv");
      expect(payload?.options).toHaveProperty("envKeyCount");

      const serialized = JSON.stringify(
        spy.calls,
        (_key, value) => (typeof value === "function" ? "[function]" : value)
      );
      expect(serialized).not.toContain(envSecret);
      expect(serialized).not.toContain(runtimeSecret);
      expect(serialized).not.toContain(systemSecret);
    } finally {
      await session.close();
      if (previousEnv === undefined) {
        delete process.env.PASEO_TEST_SENTINEL_SECRET;
      } else {
        process.env.PASEO_TEST_SENTINEL_SECRET = previousEnv;
      }
    }
  });

  test("emits interrupt step diagnostics at debug level only", async () => {
    const spy = createSpyLogger();
    const session = await createSessionWithLogger(spy.logger);
    const internal = session as unknown as {
      query:
        | {
            interrupt: () => Promise<void>;
            return?: () => Promise<void>;
          }
        | null;
      input: { end: () => void } | null;
      queryRestartNeeded: boolean;
      interruptActiveTurn: () => Promise<void>;
    };
    const interrupt = vi.fn(async () => undefined);
    const queryReturn = vi.fn(async () => undefined);
    const end = vi.fn(() => undefined);
    internal.query = {
      interrupt,
      return: queryReturn,
    };
    internal.input = { end };
    internal.queryRestartNeeded = false;

    try {
      await internal.interruptActiveTurn();

      const interruptInfoMessages = extractStringLogArgs(spy.info.mock.calls).filter(
        (message) => message.includes("interruptActiveTurn")
      );
      const interruptDebugMessages = extractStringLogArgs(
        spy.debug.mock.calls
      ).filter((message) => message.includes("interruptActiveTurn"));

      expect(interruptInfoMessages).toEqual([]);
      expect(interruptDebugMessages).toEqual([
        "interruptActiveTurn: calling query.interrupt()...",
        "interruptActiveTurn: query.interrupt() returned",
        "interruptActiveTurn: calling query.return()...",
        "interruptActiveTurn: query.return() returned",
      ]);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(queryReturn).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(internal.query).toBeNull();
      expect(internal.input).toBeNull();
      expect(internal.queryRestartNeeded).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("extracts identifiers from fixture-driven protocol shape variants", async () => {
    const spy = createSpyLogger();
    const session = await createSessionWithLogger(spy.logger);
    const internal = session as unknown as {
      routeSdkMessageFromPump: (message: Record<string, unknown>) => void;
    };

    const fixtures = [
      {
        name: "root identifiers take priority over nested variants",
        message: {
          type: "stream_event",
          task_id: "task-root",
          parent_message_id: "parent-root",
          message_id: "msg-root",
          event: {
            type: "message_delta",
            task_id: "task-event",
            parent_message_id: "parent-event",
            message_id: "msg-event",
            message: { id: "msg-event-inner" },
          },
        },
        expected: {
          taskId: "task-root",
          parentMessageId: "parent-root",
          messageId: "msg-root",
        },
      },
      {
        name: "stream_event identifiers are used when root identifiers are absent",
        message: {
          type: "stream_event",
          event: {
            type: "message_delta",
            task_id: "task-event-only",
            parent_message_id: "parent-event-only",
            message_id: "msg-event-only",
          },
        },
        expected: {
          taskId: "task-event-only",
          parentMessageId: "parent-event-only",
          messageId: "msg-event-only",
        },
      },
      {
        name: "assistant message container identifiers are used as a fallback",
        message: {
          type: "assistant",
          message: {
            id: "msg-container",
            task_id: "task-container",
            parent_message_id: "parent-container",
            content: "assistant message",
          },
        },
        expected: {
          taskId: "task-container",
          parentMessageId: "parent-container",
          messageId: "msg-container",
        },
      },
      {
        name: "user uuid is used as a message_id fallback",
        message: {
          type: "user",
          uuid: "uuid-fallback",
          message: {
            role: "user",
            content: "prompt text",
          },
        },
        expected: {
          taskId: null,
          parentMessageId: null,
          messageId: "uuid-fallback",
        },
      },
    ] as const;

    try {
      for (const fixture of fixtures) {
        spy.debug.mockClear();
        internal.routeSdkMessageFromPump(
          fixture.message as unknown as Record<string, unknown>
        );
        const routingCall = spy.debug.mock.calls.find(
          (args) => args[1] === "Claude query pump routing decision"
        );
        expect(routingCall).toBeDefined();
        const payload = routingCall?.[0] as
          | { identifiers?: Record<string, string | null> }
          | undefined;
        expect(payload?.identifiers).toEqual(fixture.expected);
      }
    } finally {
      await session.close();
    }
  });

  test("captures session IDs from fixture-driven init message variants", async () => {
    const fixtures = [
      {
        name: "session_id field",
        payload: { session_id: " session-id-1 " },
        expected: "session-id-1",
      },
      {
        name: "sessionId field",
        payload: { sessionId: " session-id-2 " },
        expected: "session-id-2",
      },
      {
        name: "nested session.id field",
        payload: { session: { id: " session-id-3 " } },
        expected: "session-id-3",
      },
    ] as const;

    for (const fixture of fixtures) {
      const session = await createSession();
      const internal = session as unknown as {
        handleSystemMessage: (message: Record<string, unknown>) => string | null;
      };
      try {
        const started = internal.handleSystemMessage({
          type: "system",
          subtype: "init",
          permissionMode: "default",
          model: "opus",
          ...fixture.payload,
        });
        expect(started).toBe(fixture.expected);
        expect(session.describePersistence()?.sessionId).toBe(fixture.expected);
      } finally {
        await session.close();
      }
    }
  });

  test("applies input_json_delta updates only when buffered JSON is complete", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      mapPartialEvent: (event: Record<string, unknown>) => AgentTimelineItem[];
      toolUseCache: Map<string, { input?: Record<string, unknown> }>;
      toolUseIndexToId: Map<number, string>;
      toolUseInputBuffers: Map<string, string>;
    };

    const toolUseId = "tool-input-delta";
    const index = 7;
    try {
      internal.mapPartialEvent({
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "echo seed" },
        },
      });

      const readCommand = () => {
        const command = internal.toolUseCache.get(toolUseId)?.input?.command;
        return typeof command === "string" ? command : null;
      };

      const deltaFixtures = [
        {
          event: {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: "{\"command\":\"echo ",
            },
          },
          expectedCommand: "echo seed",
        },
        {
          event: {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: "delta\"}",
            },
          },
          expectedCommand: "echo delta",
        },
        {
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: "{\"command\":\"ignored\"}",
            },
          },
          expectedCommand: "echo delta",
        },
      ] as const;

      for (const fixture of deltaFixtures) {
        internal.mapPartialEvent(
          fixture.event as unknown as Record<string, unknown>
        );
        expect(readCommand()).toBe(fixture.expectedCommand);
      }

      internal.mapPartialEvent({
        type: "content_block_stop",
        index,
      });
      expect(internal.toolUseIndexToId.has(index)).toBe(false);
      expect(internal.toolUseInputBuffers.has(toolUseId)).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("maps tool_result content shapes into deterministic string output", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      buildToolOutput: (
        block: Record<string, unknown>,
        entry: Record<string, unknown> | undefined
      ) => Record<string, unknown> | undefined;
    };

    const toolEntry = {
      id: "tool-1",
      name: "Bash",
      server: "Bash",
      classification: "command",
      started: true,
      input: {
        command: "echo hello",
      },
    };

    const fixtures = [
      {
        name: "string content",
        content: "plain output",
        expectedOutput: "plain output",
      },
      {
        name: "text block array content",
        content: [
          { type: "text", text: "first line\n" },
          { type: "text", text: "second line" },
        ],
        expectedOutput: "first line\nsecond line",
      },
      {
        name: "structured fallback content",
        content: {
          z: 3,
          nested: {
            b: 2,
            a: 1,
          },
          a: 0,
        },
        expectedOutput: "{\"a\":0,\"nested\":{\"a\":1,\"b\":2},\"z\":3}",
      },
    ] as const;

    try {
      for (const fixture of fixtures) {
        const output = internal.buildToolOutput(
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: fixture.content,
            is_error: false,
          },
          toolEntry
        );
        expect(output).toEqual(
          expect.objectContaining({
            type: "command",
            command: "echo hello",
            output: fixture.expectedOutput,
          })
        );
      }
    } finally {
      await session.close();
    }
  });

  test("routes by deterministic identifier priority: task_id > parent_message_id > message_id", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      createRun: (owner: "autonomous", queue: null) => { id: string };
      runTracker: {
        bindIdentifiers: (
          run: { id: string },
          ids: { taskId: string | null; parentMessageId: string | null; messageId: string | null }
        ) => void;
      };
      routeMessage: (input: {
        message: AgentStreamEvent | Record<string, unknown>;
        identifiers: { taskId: string | null; parentMessageId: string | null; messageId: string | null };
        metadataOnly: boolean;
      }) => { run: { id: string } | null; reason: string };
      turnState: "autonomous";
    };

    const taskRun = internal.createRun("autonomous", null);
    internal.runTracker.bindIdentifiers(taskRun, {
      taskId: "task-A",
      parentMessageId: null,
      messageId: "msg-A",
    });

    const parentRun = internal.createRun("autonomous", null);
    internal.runTracker.bindIdentifiers(parentRun, {
      taskId: null,
      parentMessageId: "parent-B",
      messageId: "msg-B",
    });

    const messageRun = internal.createRun("autonomous", null);
    internal.runTracker.bindIdentifiers(messageRun, {
      taskId: null,
      parentMessageId: null,
      messageId: "msg-C",
    });

    internal.turnState = "autonomous";

    const taskPriorityRoute = internal.routeMessage({
      message: { type: "assistant", message: { content: "task-priority" } },
      identifiers: {
        taskId: "task-A",
        parentMessageId: "parent-B",
        messageId: "msg-C",
      },
      metadataOnly: false,
    });
    expect(taskPriorityRoute.reason).toBe("task_id");
    expect(taskPriorityRoute.run?.id).toBe(taskRun.id);

    const parentPriorityRoute = internal.routeMessage({
      message: { type: "assistant", message: { content: "parent-priority" } },
      identifiers: {
        taskId: null,
        parentMessageId: "parent-B",
        messageId: "msg-C",
      },
      metadataOnly: false,
    });
    expect(parentPriorityRoute.reason).toBe("parent_message_id");
    expect(parentPriorityRoute.run?.id).toBe(parentRun.id);

    const messagePriorityRoute = internal.routeMessage({
      message: { type: "assistant", message: { content: "message-priority" } },
      identifiers: {
        taskId: null,
        parentMessageId: null,
        messageId: "msg-C",
      },
      metadataOnly: false,
    });
    expect(messagePriorityRoute.reason).toBe("message_id");
    expect(messagePriorityRoute.run?.id).toBe(messageRun.id);

    await session.close();
  });

  test("does not route unbound events to foreground before prompt replay is observed", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      createRun: (owner: "foreground" | "autonomous", queue: unknown) => { id: string };
      runTracker: {
        bindIdentifiers: (
          run: { id: string },
          ids: { taskId: string | null; parentMessageId: string | null; messageId: string | null }
        ) => void;
      };
      activeForegroundTurn: { runId: string; queue: unknown } | null;
      turnState: "foreground";
      routeMessage: (input: {
        message: Record<string, unknown>;
        identifiers: { taskId: string | null; parentMessageId: string | null; messageId: string | null };
        metadataOnly: boolean;
      }) => { run: { id: string } | null; reason: string };
    };

    const foregroundQueueStub = {
      push: () => undefined,
      end: () => undefined,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
      }),
    };
    const foregroundRun = internal.createRun("foreground", foregroundQueueStub);
    internal.turnState = "foreground";
    internal.activeForegroundTurn = {
      runId: foregroundRun.id,
      queue: foregroundQueueStub,
    };

    const unboundBeforeReplay = internal.routeMessage({
      message: { type: "assistant", message: { content: "stale-before-replay" } },
      identifiers: {
        taskId: null,
        parentMessageId: null,
        messageId: null,
      },
      metadataOnly: false,
    });
    expect(unboundBeforeReplay.reason).toBe("foreground");
    expect(unboundBeforeReplay.run?.id).toBe(foregroundRun.id);

    const promptReplayId = "foreground-replay-id";
    internal.runTracker.bindIdentifiers(foregroundRun, {
      taskId: null,
      parentMessageId: null,
      messageId: promptReplayId,
    });
    const replayRoute = internal.routeMessage({
      message: {
        type: "user",
        message: { role: "user", content: "prompt replay" },
        uuid: promptReplayId,
      },
      identifiers: {
        taskId: null,
        parentMessageId: null,
        messageId: promptReplayId,
      },
      metadataOnly: false,
    });
    expect(replayRoute.reason).toBe("message_id");
    expect(replayRoute.run?.id).toBe(foregroundRun.id);

    await session.close();
  });

  test("reuses one autonomous run for unbound stream_event bursts with no foreground run", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      turnState: "idle" | "foreground" | "autonomous";
      nextRunOrdinal: number;
      routeSdkMessageFromPump: (message: Record<string, unknown>) => void;
      runTracker: {
        listActiveRuns: (owner?: "foreground" | "autonomous") => Array<{ id: string }>;
      };
    };

    internal.turnState = "idle";
    internal.routeSdkMessageFromPump({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "AUTO " },
      },
    });

    const firstRun = internal.runTracker.listActiveRuns("autonomous");
    expect(firstRun).toHaveLength(1);
    expect(internal.nextRunOrdinal).toBe(2);

    internal.routeSdkMessageFromPump({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "WAKE" },
      },
    });
    const secondRun = internal.runTracker.listActiveRuns("autonomous");
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0]?.id).toBe(firstRun[0]?.id);
    expect(internal.nextRunOrdinal).toBe(2);

    internal.routeSdkMessageFromPump({
      type: "result",
      subtype: "success",
      usage: buildUsage(),
      total_cost_usd: 0,
    });
    expect(internal.runTracker.listActiveRuns("autonomous")).toHaveLength(0);

    await session.close();
  });

  test("pushEvent does not route side-channel events into a stale foreground queue", async () => {
    const session = await createSession();
    const staleQueueEvents: AgentStreamEvent[] = [];
    const staleQueue = {
      push: (event: AgentStreamEvent) => staleQueueEvents.push(event),
      end: () => undefined,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
      }),
    };

    const internal = session as unknown as {
      createRun: (owner: "foreground" | "autonomous", queue: unknown) => { id: string };
      activeForegroundTurn: { runId: string; queue: unknown } | null;
      runTracker: { getRun: (runId: string) => unknown; complete: (run: unknown, state: "completed") => void };
      pushEvent: (event: AgentStreamEvent) => void;
    };

    const staleForegroundRun = internal.createRun("foreground", staleQueue);
    const runRecord = internal.runTracker.getRun(staleForegroundRun.id);
    internal.runTracker.complete(runRecord, "completed");
    internal.activeForegroundTurn = {
      runId: staleForegroundRun.id,
      queue: staleQueue,
    };

    const liveIterator = (
      session as unknown as {
        streamLiveEvents: () => AsyncGenerator<AgentStreamEvent>;
      }
    ).streamLiveEvents();
    const permissionEvent: AgentStreamEvent = {
      type: "permission_requested",
      provider: "claude",
      request: {
        id: "permission-1",
        provider: "claude",
        name: "Bash",
        kind: "tool",
      },
    };
    internal.pushEvent(permissionEvent);

    const next = await Promise.race([
      liveIterator.next(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for live side-channel event")), 1_000);
      }),
    ]);

    expect(next.done).toBe(false);
    expect(next.value).toEqual(permissionEvent);
    expect(staleQueueEvents).toHaveLength(0);
    expect(internal.activeForegroundTurn).toBeNull();

    await liveIterator.return?.();
    await session.close();
  });

  test("tracks run lifecycle transitions for success, error, and interrupt", async () => {
    const session = await createSession();
    let streamCase: "success" | "error" | "interrupt" = "success";

    sdkMocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const readPromptUuid = createPromptUuidReader(prompt);
      let step = 0;
      let interruptRequested = false;

      const mock = createBaseQueryMock(
        vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "redesign-lifecycle-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: "prompt replay" },
                parent_tool_use_id: null,
                uuid: (await readPromptUuid()) ?? "missing-prompt-uuid",
                session_id: "redesign-lifecycle-session",
              },
            };
          }
          if (step === 2) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: { content: "assistant output" },
              },
            };
          }
          if (streamCase === "interrupt") {
            if (!interruptRequested) {
              await new Promise<void>((resolve) => setTimeout(resolve, 50));
              return {
                done: false,
                value: {
                  type: "assistant",
                  message: { content: "waiting for interrupt" },
                },
              };
            }
            return { done: true, value: undefined };
          }
          if (step === 3) {
            step += 1;
            if (streamCase === "success") {
              return {
                done: false,
                value: {
                  type: "result",
                  subtype: "success",
                  usage: buildUsage(),
                  total_cost_usd: 0,
                },
              };
            }
            return {
              done: false,
              value: {
                type: "result",
                subtype: "error",
                usage: buildUsage(),
                errors: ["simulated failure"],
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        })
      );

      mock.interrupt.mockImplementation(async () => {
        interruptRequested = true;
      });
      return mock;
    });

    streamCase = "success";
    const successEvents = await collectUntilTerminal(session.stream("success prompt"));
    expect(successEvents.some((event) => event.type === "turn_completed")).toBe(
      true
    );
    expect(successEvents.some((event) => event.type === "turn_failed")).toBe(
      false
    );
    expect(successEvents.some((event) => event.type === "turn_canceled")).toBe(
      false
    );

    streamCase = "error";
    const errorEvents = await collectUntilTerminal(session.stream("error prompt"));
    expect(errorEvents.some((event) => event.type === "turn_failed")).toBe(true);
    expect(errorEvents.some((event) => event.type === "turn_completed")).toBe(
      false
    );

    streamCase = "interrupt";
    const interruptStream = session.stream("interrupt prompt");
    const interruptEvents: AgentStreamEvent[] = [];
    for await (const event of interruptStream) {
      interruptEvents.push(event);
      if (
        event.type === "timeline" &&
        event.item.type === "assistant_message"
      ) {
        await session.interrupt();
      }
      if (event.type === "turn_canceled") {
        break;
      }
    }
    expect(interruptEvents.some((event) => event.type === "turn_canceled")).toBe(
      true
    );

    await session.close();
  });

  test("assembles assistant timeline when message_delta arrives before message_start", async () => {
    sdkMocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const readPromptUuid = createPromptUuidReader(prompt);
      let step = 0;
      return createBaseQueryMock(
        vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "redesign-timeline-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: "timeline prompt" },
                parent_tool_use_id: null,
                uuid: (await readPromptUuid()) ?? "missing-prompt-uuid",
                session_id: "redesign-timeline-session",
              },
            };
          }
          if (step === 2) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "HELLO " },
                },
              },
            };
          }
          if (step === 3) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                event: {
                  type: "message_start",
                  message: { id: "message-1", role: "assistant", model: "opus" },
                },
              },
            };
          }
          if (step === 4) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  message_id: "message-1",
                  delta: { type: "text_delta", text: "WORLD" },
                },
              },
            };
          }
          if (step === 5) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                event: {
                  type: "message_stop",
                  message_id: "message-1",
                },
              },
            };
          }
          if (step === 6) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        })
      );
    });

    const session = await createSession();
    const events = await collectUntilTerminal(session.stream("timeline prompt"));
    const assistantText = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline" && event.item.type === "assistant_message"
      )
      .map((event) => event.item.text)
      .join("");

    expect(assistantText).toContain("HELLO WORLD");

    await session.close();
  });

  test("does not use stream_event uuid as assistant message identity when message_id is missing", async () => {
    sdkMocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const readPromptUuid = createPromptUuidReader(prompt);
      let step = 0;
      return createBaseQueryMock(
        vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "redesign-stream-event-uuid-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: "uuid fallback prompt" },
                parent_tool_use_id: null,
                uuid: (await readPromptUuid()) ?? "missing-prompt-uuid",
                session_id: "redesign-stream-event-uuid-session",
              },
            };
          }
          if (step === 2) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                uuid: "stream-event-uuid-1",
                event: {
                  type: "message_start",
                  message: { role: "assistant", model: "opus" },
                },
              },
            };
          }
          if (step === 3) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                uuid: "stream-event-uuid-2",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "HELLO " },
                },
              },
            };
          }
          if (step === 4) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                uuid: "stream-event-uuid-3",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "WORLD" },
                },
              },
            };
          }
          if (step === 5) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                uuid: "stream-event-uuid-4",
                event: {
                  type: "message_stop",
                },
              },
            };
          }
          if (step === 6) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        })
      );
    });

    const session = await createSession();
    const events = await collectUntilTerminal(session.stream("uuid fallback prompt"));
    const assistantText = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline" && event.item.type === "assistant_message"
      )
      .map((event) => event.item.text)
      .join("");

    expect(assistantText).toContain("HELLO WORLD");

    const assembler = session as unknown as {
      timelineAssembler: { messages: Map<string, unknown> };
    };
    expect(assembler.timelineAssembler.messages.size).toBe(1);

    await session.close();
  });

  test("surfaces autonomous running transitions during true overlap before foreground terminal result", async () => {
    sdkMocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const readPromptUuid = createPromptUuidReader(prompt);
      let step = 0;
      return createBaseQueryMock(
        vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "redesign-manager-overlap-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: "foreground prompt replay" },
                parent_tool_use_id: null,
                uuid: (await readPromptUuid()) ?? "missing-prompt-uuid",
                session_id: "redesign-manager-overlap-session",
              },
            };
          }
          if (step === 2) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                task_id: "fg-1",
                message: { content: "FOREGROUND_BEFORE_OVERLAP" },
              },
            };
          }
          if (step === 3) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                task_id: "bg-1",
                event: {
                  type: "message_start",
                  message: { id: "bg-msg-1", role: "assistant", model: "opus" },
                },
              },
            };
          }
          if (step === 4) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                task_id: "bg-1",
                event: {
                  type: "content_block_delta",
                  message_id: "bg-msg-1",
                  delta: { type: "text_delta", text: "AUTONOMOUS_OVERLAP_DONE" },
                },
              },
            };
          }
          if (step === 5) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                task_id: "bg-1",
                event: {
                  type: "message_stop",
                  message_id: "bg-msg-1",
                },
              },
            };
          }
          if (step === 6) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                task_id: "bg-1",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          if (step === 7) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: { content: "FOREGROUND_DONE" },
              },
            };
          }
          if (step === 8) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        })
      );
    });

    const logger = createTestLogger();
    const manager = new AgentManager({
      clients: {
        claude: new ClaudeAgentClient({ logger }),
      },
      logger,
    });

    const agent = await manager.createAgent({
      provider: "claude",
      cwd: process.cwd(),
    });

    const runningStateEvents: string[] = [];
    const turnStartedEvents: AgentStreamEvent[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.id === agent.id) {
          if (event.agent.lifecycle === "running") {
            runningStateEvents.push(event.agent.lifecycle);
          }
          return;
        }
        if (
          event.type === "agent_stream" &&
          event.agentId === agent.id &&
          event.event.type === "turn_started"
        ) {
          turnStartedEvents.push(event.event);
        }
      },
      { agentId: agent.id, replayState: true }
    );

    const foregroundEvents = await collectUntilTerminal(
      manager.streamAgent(agent.id, "foreground prompt")
    );
    expect(
      foregroundEvents.some((event) => event.type === "turn_completed")
    ).toBe(true);
    expect(
      foregroundEvents.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("AUTONOMOUS_OVERLAP_DONE")
      )
    ).toBe(false);

    await waitForCondition(() => turnStartedEvents.length >= 1, 5_000);
    await waitForCondition(() => runningStateEvents.length >= 2, 5_000);

    const timeline = manager.getTimeline(agent.id);
    expect(
      timeline.some(
        (item) =>
          item.type === "assistant_message" &&
          item.text.includes("FOREGROUND_BEFORE_OVERLAP")
      )
    ).toBe(true);
    expect(
      timeline.some(
        (item) =>
          item.type === "assistant_message" &&
          item.text.includes("FOREGROUND_DONE")
      )
    ).toBe(true);
    expect(
      timeline.some(
        (item) =>
          item.type === "assistant_message" &&
          item.text.includes("AUTONOMOUS_OVERLAP_DONE")
      )
    ).toBe(true);

    unsubscribe();
    await manager.closeAgent(agent.id);
  });
});
