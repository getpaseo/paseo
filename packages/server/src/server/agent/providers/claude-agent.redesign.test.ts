import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Logger } from "pino";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ClaudeAgentClient, readEventIdentifiers } from "./claude-agent.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";

type QueryMock = {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>, void>;
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
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function createSession() {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
  });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
}

function createSessionWithLogger(logger: Logger) {
  const client = new ClaudeAgentClient({
    logger,
    queryFactory: sdkQueryFactory,
  });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
}

const sdkQueryFactory = vi.fn();

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
  return calls.flatMap((args) => args.filter((arg): arg is string => typeof arg === "string"));
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
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

async function waitForCondition(check: () => boolean, timeoutMs: number): Promise<void> {
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
    sdkQueryFactory.mockReset();
  });

  afterEach(() => {
    sdkQueryFactory.mockReset();
  });

  test("logs redacted query summary and never leaks sentinel secrets", async () => {
    const envSecret = "PASEO_ENV_SENTINEL_SECRET";
    const runtimeSecret = "PASEO_RUNTIME_SENTINEL_SECRET";
    const systemSecret = "PASEO_SYSTEM_PROMPT_SENTINEL_SECRET";
    const previousEnv = process.env.PASEO_TEST_SENTINEL_SECRET;
    process.env.PASEO_TEST_SENTINEL_SECRET = envSecret;

    sdkQueryFactory.mockImplementation(() => {
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
        }),
      );
    });

    const spy = createSpyLogger();
    const client = new ClaudeAgentClient({
      logger: spy.logger,
      queryFactory: sdkQueryFactory,
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

      const queryLogCall = spy.debug.mock.calls.find((args) => args[1] === "claude query");
      expect(queryLogCall).toBeDefined();
      const payload = queryLogCall?.[0] as { options?: Record<string, unknown> } | undefined;
      expect(payload?.options).toBeDefined();
      expect(payload?.options).not.toHaveProperty("env");
      expect(payload?.options).not.toHaveProperty("systemPrompt");
      expect(payload?.options).not.toHaveProperty("canUseTool");
      expect(payload?.options).toHaveProperty("hasEnv");
      expect(payload?.options).toHaveProperty("envKeyCount");

      const serialized = JSON.stringify(spy.calls, (_key, value) =>
        typeof value === "function" ? "[function]" : value,
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

  test("interruptActiveTurn only interrupts the active query without info logs", async () => {
    const spy = createSpyLogger();
    const session = await createSessionWithLogger(spy.logger);
    const internal = session as unknown as {
      query: {
        interrupt: () => Promise<void>;
        return?: () => Promise<void>;
        close?: () => void;
      } | null;
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
      close: vi.fn(() => undefined),
    };
    internal.input = { end };
    internal.queryRestartNeeded = false;

    try {
      await internal.interruptActiveTurn();

      const interruptInfoMessages = extractStringLogArgs(spy.info.mock.calls).filter((message) =>
        message.includes("interruptActiveTurn"),
      );
      const interruptDebugMessages = extractStringLogArgs(spy.debug.mock.calls).filter((message) =>
        message.includes("interruptActiveTurn"),
      );

      expect(interruptInfoMessages).toEqual([]);
      expect(interruptDebugMessages).toEqual([]);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(queryReturn).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
      expect(internal.query).not.toBeNull();
      expect(internal.input).not.toBeNull();
      expect(internal.queryRestartNeeded).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("extracts identifiers from fixture-driven protocol shape variants", () => {
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

    for (const fixture of fixtures) {
      expect(
        readEventIdentifiers(
          fixture.message as unknown as Parameters<typeof readEventIdentifiers>[0],
        ),
      ).toEqual(fixture.expected);
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

  test("waits for complete JSON values before updating tool input from input_json_delta", async () => {
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
              partial_json: '{"command":"echo ',
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
              partial_json: 'delta"}',
            },
          },
          expectedCommand: "echo delta",
        },
        {
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"command":"ignored"}',
            },
          },
          expectedCommand: "echo delta",
        },
      ] as const;

      for (const fixture of deltaFixtures) {
        internal.mapPartialEvent(fixture.event as unknown as Record<string, unknown>);
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

  test("does not surface incomplete string values from input_json_delta", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      mapPartialEvent: (event: Record<string, unknown>) => AgentTimelineItem[];
      toolUseCache: Map<string, { input?: Record<string, unknown> }>;
    };

    const toolUseId = "tool-input-preview";
    const index = 8;
    try {
      internal.mapPartialEvent({
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: "Edit",
        },
      });

      internal.mapPartialEvent({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path":"src/message.tsx","old_string":"before',
        },
      });

      expect(internal.toolUseCache.get(toolUseId)?.input).toEqual({
        file_path: "src/message.tsx",
      });
    } finally {
      await session.close();
    }
  });

  test("maps tool_result content shapes into deterministic string output", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      buildToolOutput: (
        block: Record<string, unknown>,
        entry: Record<string, unknown> | undefined,
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
        expectedOutput: '{"a":0,"nested":{"a":1,"b":2},"z":3}',
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
          toolEntry,
        );
        expect(output).toEqual(
          expect.objectContaining({
            type: "command",
            command: "echo hello",
            output: fixture.expectedOutput,
          }),
        );
      }
    } finally {
      await session.close();
    }
  });

  test("completes a foreground run when only system metadata arrives before the first assistant message", async () => {
    let step = 0;
    sdkQueryFactory.mockImplementation(() =>
      createBaseQueryMock(
        vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "redesign-metadata-only-session",
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
                type: "system",
                subtype: "hook_response",
                session_id: "redesign-metadata-only-session",
                hook_name: "SessionStart:Callback",
                hook_event: "SessionStart",
                stdout: "",
                stderr: "",
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
          if (step === 3) {
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
        }),
      ),
    );

    const session = await createSession();
    try {
      const events = await Promise.race([
        collectUntilTerminal(streamSession(session, "metadata helper prompt")),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Timed out waiting for foreground terminal event")),
            1_000,
          );
        }),
      ]);

      expect(events.some((event) => event.type === "turn_completed")).toBe(true);

      const assistantText = events
        .filter(
          (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
            event.type === "timeline" && event.item.type === "assistant_message",
        )
        .map((event) => event.item.text)
        .join("");
      expect(assistantText).toContain("assistant output");
    } finally {
      await session.close();
    }
  });

  test("captures Claude stderr in the turn failure diagnostic when stderr arrives after process exit", async () => {
    const stderrMessage =
      'Error: Effort level "max" is not available for Claude.ai subscribers. Please use "low", "medium", or "high".';
    let capturedOptions:
      | {
          stderr?: (data: string) => void;
          effort?: string;
          permissionMode?: string;
        }
      | undefined;

    sdkQueryFactory.mockImplementation(
      ({ options }: { options: { stderr?: (data: string) => void; effort?: string } }) => {
        capturedOptions = options;
        let failed = false;
        return createBaseQueryMock(
          vi.fn(async () => {
            if (!failed) {
              failed = true;
              setTimeout(() => {
                options.stderr?.(`${stderrMessage}\n`);
              }, 0);
              throw new Error("Claude Code process exited with code 1");
            }
            return { done: true, value: undefined };
          }),
        );
      },
    );

    const loggerSpy = createSpyLogger();
    const client = new ClaudeAgentClient({
      logger: loggerSpy.logger,
      queryFactory: sdkQueryFactory,
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      modeId: "bypassPermissions",
      thinkingOptionId: "max",
    });

    try {
      const events = await collectUntilTerminal(streamSession(session, "trigger max failure"));
      const failure = events.find(
        (event): event is Extract<AgentStreamEvent, { type: "turn_failed" }> =>
          event.type === "turn_failed",
      );

      expect(capturedOptions?.permissionMode).toBe("bypassPermissions");
      expect(capturedOptions?.effort).toBe("max");
      expect(failure).toMatchObject({
        type: "turn_failed",
        error: "Claude Code process exited with code 1",
        code: "1",
        diagnostic: stderrMessage,
      });
      expect(loggerSpy.error).toHaveBeenCalledWith(
        expect.objectContaining({ stderr: stderrMessage }),
        "Claude Agent SDK stderr",
      );
    } finally {
      await session.close();
    }
  });

  test("preserves bypass capability across query restarts triggered by thinking changes", async () => {
    const capturedOptions: Array<{
      permissionMode?: string;
      allowDangerouslySkipPermissions?: boolean;
      effort?: string;
    }> = [];

    sdkQueryFactory.mockImplementation(
      ({
        options,
      }: {
        options: {
          permissionMode?: string;
          allowDangerouslySkipPermissions?: boolean;
          effort?: string;
        };
      }) => {
        capturedOptions.push({
          permissionMode: options.permissionMode,
          allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
          effort: options.effort,
        });

        return createBaseQueryMock(
          vi.fn(async () => ({ done: true, value: undefined })),
        );
      },
    );

    const session = await createSession();

    try {
      await session.setMode("bypassPermissions");
      await session.setMode("acceptEdits");
      await session.setThinkingOption("high");
      await session.setMode("bypassPermissions");

      expect(capturedOptions).toHaveLength(2);
      expect(capturedOptions[0]).toMatchObject({
        permissionMode: "default",
        allowDangerouslySkipPermissions: true,
      });
      expect(capturedOptions[1]).toMatchObject({
        permissionMode: "acceptEdits",
        allowDangerouslySkipPermissions: true,
        effort: "high",
      });
    } finally {
      await session.close();
    }
  });

  test("plan approval exposes a resume-bypass action and can return to bypassPermissions", async () => {
    const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
    sdkQueryFactory.mockImplementation(() => queryMock);

    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    try {
      await session.setMode("bypassPermissions");
      await session.setMode("plan");

      const internal = session as unknown as {
        handlePermissionRequest: (
          toolName: string,
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<unknown>;
      };

      const pendingResolution = internal.handlePermissionRequest(
        "ExitPlanMode",
        { plan: "- Implement the approved plan" },
        {},
      );

      const requestEvent = events.find(
        (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
          event.type === "permission_requested" && event.request.kind === "plan",
      );

      expect(requestEvent).toBeDefined();
      expect(requestEvent?.request.actions).toEqual([
        {
          id: "reject",
          label: "Reject",
          behavior: "deny",
          variant: "danger",
          intent: "dismiss",
        },
        {
          id: "implement",
          label: "Implement",
          behavior: "allow",
          variant: "primary",
          intent: "implement",
        },
        {
          id: "implement_resume",
          label: "Implement with Bypass",
          behavior: "allow",
          variant: "secondary",
          intent: "implement_resume",
        },
      ]);

      if (!requestEvent) {
        throw new Error("Expected plan permission request");
      }

      await session.respondToPermission(requestEvent.request.id, {
        behavior: "allow",
        selectedActionId: "implement_resume",
      });

      await expect(pendingResolution).resolves.toMatchObject({
        behavior: "allow",
        updatedInput: { plan: "- Implement the approved plan" },
      });
      expect(queryMock.setPermissionMode).toHaveBeenLastCalledWith("bypassPermissions");
      expect(await session.getCurrentMode()).toBe("bypassPermissions");
    } finally {
      await session.close();
    }
  });

  test("reuses one autonomous run for unbound stream_event bursts with no foreground run", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      turnState: "idle" | "foreground" | "autonomous";
      nextTurnOrdinal: number;
      routeSdkMessageFromPump: (message: Record<string, unknown>) => void;
      autonomousTurn: { id: string } | null;
    };

    internal.turnState = "idle";
    internal.routeSdkMessageFromPump({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "AUTO " },
      },
    });

    const firstRunId = internal.autonomousTurn?.id ?? null;
    expect(firstRunId).toBe("autonomous-turn-1");
    expect(internal.nextTurnOrdinal).toBe(2);

    internal.routeSdkMessageFromPump({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "WAKE" },
      },
    });
    expect(internal.autonomousTurn?.id).toBe(firstRunId);
    expect(internal.nextTurnOrdinal).toBe(2);

    internal.routeSdkMessageFromPump({
      type: "result",
      subtype: "success",
      usage: buildUsage(),
      total_cost_usd: 0,
    });
    expect(internal.autonomousTurn).toBeNull();

    await session.close();
  });

  test("tracks run lifecycle transitions for success, error, and interrupt", async () => {
    const session = await createSession();
    let streamCase: "success" | "error" | "interrupt" = "success";

    sdkQueryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
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
        }),
      );

      mock.interrupt.mockImplementation(async () => {
        interruptRequested = true;
      });
      return mock;
    });

    streamCase = "success";
    const successEvents = await collectUntilTerminal(streamSession(session, "success prompt"));
    expect(successEvents.some((event) => event.type === "turn_completed")).toBe(true);
    expect(successEvents.some((event) => event.type === "turn_failed")).toBe(false);
    expect(successEvents.some((event) => event.type === "turn_canceled")).toBe(false);

    streamCase = "error";
    const errorEvents = await collectUntilTerminal(streamSession(session, "error prompt"));
    expect(errorEvents.some((event) => event.type === "turn_failed")).toBe(true);
    expect(errorEvents.some((event) => event.type === "turn_completed")).toBe(false);

    streamCase = "interrupt";
    const interruptStream = streamSession(session, "interrupt prompt");
    const interruptEvents: AgentStreamEvent[] = [];
    for await (const event of interruptStream) {
      interruptEvents.push(event);
      if (event.type === "timeline" && event.item.type === "assistant_message") {
        await session.interrupt();
      }
      if (event.type === "turn_canceled") {
        break;
      }
    }
    expect(interruptEvents.some((event) => event.type === "turn_canceled")).toBe(true);

    await session.close();
  });

  test("assembles assistant timeline when message_delta arrives before message_start", async () => {
    sdkQueryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
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
        }),
      );
    });

    const session = await createSession();
    const events = await collectUntilTerminal(streamSession(session, "timeline prompt"));
    const assistantText = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline" && event.item.type === "assistant_message",
      )
      .map((event) => event.item.text)
      .join("");

    expect(assistantText).toContain("HELLO WORLD");

    await session.close();
  });

  test("does not use stream_event uuid as assistant message identity when message_id is missing", async () => {
    sdkQueryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
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
        }),
      );
    });

    const session = await createSession();
    const events = await collectUntilTerminal(streamSession(session, "uuid fallback prompt"));
    const assistantText = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline" && event.item.type === "assistant_message",
      )
      .map((event) => event.item.text)
      .join("");

    expect(assistantText).toContain("HELLO WORLD");

    const assembler = session as unknown as {
      timelineAssembler: { messages: Map<string, unknown> };
    };
    expect(assembler.timelineAssembler.messages.size).toBe(0);

    await session.close();
  });
});
