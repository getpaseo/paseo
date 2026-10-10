import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Logger } from "pino";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { asInternals } from "../../../test-utils/class-mocks.js";
import { ClaudeAgentClient, readEventIdentifiers } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";

interface QueryMock {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>, void>;
}

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
    getContextUsage: vi.fn(async () => undefined),
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
    resolveBinary: async () => "/test/claude/bin",
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
    resolveBinary: async () => "/test/claude/bin",
  });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
}

const sdkQueryFactory = vi.fn();

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  args: unknown[];
}

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
    logger: asInternals<Logger>(loggerLike),
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

function restoreEnvValue(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
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

beforeEach(() => {
  sdkQueryFactory.mockReset();
});

afterEach(() => {
  sdkQueryFactory.mockReset();
});

test("exposes and applies auto permission mode", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);

  const session = await createSession();

  try {
    await expect(session.getAvailableModes()).resolves.toEqual(
      expect.arrayContaining([
        {
          id: "auto",
          label: "Auto mode",
          description: "Uses a model classifier to review permission prompts automatically",
        },
      ]),
    );

    await session.setMode("auto");

    expect(queryMock.setPermissionMode).toHaveBeenCalledWith("auto");
    expect(await session.getCurrentMode()).toBe("auto");
  } finally {
    await session.close();
  }
});

test("rejects auto mode when Claude Code uses Bedrock", async () => {
  const previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";

  const session = await createSession();

  try {
    await expect(session.setMode("auto")).rejects.toThrow(
      "Claude Auto mode requires the Anthropic API and is not supported when Claude Code uses Bedrock",
    );
    expect(sdkQueryFactory).not.toHaveBeenCalled();
  } finally {
    restoreEnvValue("CLAUDE_CODE_USE_BEDROCK", previousBedrock);
    await session.close();
  }
});

test.each([
  { env: {}, expected: "auto" },
  { env: { CLAUDE_CODE_USE_BEDROCK: "1" }, expected: "default" },
  { env: { CLAUDE_CODE_USE_VERTEX: "true" }, expected: "default" },
])("defaults to $expected for transport environment $env", async ({ env, expected }) => {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { env },
  });

  await expect(
    client.resolveDefaultModeId({
      config: { provider: "claude", cwd: process.cwd() },
    }),
  ).resolves.toBe(expected);
});

test("launch environment participates in the Claude default mode", async () => {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { env: {} },
  });

  await expect(
    client.resolveDefaultModeId({
      config: { provider: "claude", cwd: process.cwd() },
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    }),
  ).resolves.toBe("default");
});

test("keeps Auto mode available when hosted-transport flags are explicitly disabled", async () => {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: {
      env: { CLAUDE_CODE_USE_BEDROCK: "off", CLAUDE_CODE_USE_VERTEX: "0" },
    },
  });

  await expect(
    client.resolveDefaultModeId({
      config: { provider: "claude", cwd: process.cwd() },
    }),
  ).resolves.toBe("auto");
});

test("allows launch env to disable inherited Bedrock transport for auto mode", async () => {
  const previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession(
    {
      provider: "claude",
      cwd: process.cwd(),
    },
    { env: { CLAUDE_CODE_USE_BEDROCK: "0" } },
  );

  try {
    await session.setMode("auto");

    expect(queryMock.setPermissionMode).toHaveBeenCalledWith("auto");
    expect(await session.getCurrentMode()).toBe("auto");
  } finally {
    restoreEnvValue("CLAUDE_CODE_USE_BEDROCK", previousBedrock);
    await session.close();
  }
});

test("fails an auto mode turn when Claude Code uses Vertex", async () => {
  const previousVertex = process.env.CLAUDE_CODE_USE_VERTEX;
  process.env.CLAUDE_CODE_USE_VERTEX = "true";
  sdkQueryFactory.mockImplementation(() => {
    throw new Error("query should not start");
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    modeId: "auto",
  });

  try {
    const events = await collectUntilTerminal(streamSession(session, "hello"));
    const failure = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "turn_failed" }> =>
        event.type === "turn_failed",
    );

    expect(failure?.error).toContain(
      "Claude Auto mode requires the Anthropic API and is not supported when Claude Code uses Vertex",
    );
    expect(sdkQueryFactory).not.toHaveBeenCalled();
  } finally {
    restoreEnvValue("CLAUDE_CODE_USE_VERTEX", previousVertex);
    await session.close();
  }
});

test("switches an auto mode session to another mode when Claude Code uses Bedrock", async () => {
  const previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    modeId: "auto",
  });

  try {
    await session.setMode("acceptEdits");

    expect(await session.getCurrentMode()).toBe("acceptEdits");
    expect(sdkQueryFactory).toHaveBeenCalledTimes(1);
    expect(sdkQueryFactory.mock.calls[0]?.[0]?.options?.permissionMode).toBe("acceptEdits");
  } finally {
    restoreEnvValue("CLAUDE_CODE_USE_BEDROCK", previousBedrock);
    await session.close();
  }
});

test("does not keep a query started in a mode that Claude Code rejected", async () => {
  const launchedModes: Array<string | undefined> = [];
  sdkQueryFactory.mockImplementation(({ options }: { options: { permissionMode?: string } }) => {
    launchedModes.push(options.permissionMode);
    const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
    if (launchedModes.length === 1) {
      queryMock.setPermissionMode.mockRejectedValue(new Error("bypass refused"));
    }
    return queryMock;
  });
  const session = await createSession();

  try {
    await expect(session.setMode("bypassPermissions")).rejects.toThrow("bypass refused");
    await session.listCommands();

    expect(await session.getCurrentMode()).toBe("default");
    expect(launchedModes).toEqual(["bypassPermissions", "default"]);
  } finally {
    await session.close();
  }
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
    resolveBinary: async () => "/test/claude/bin",
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
  let acknowledgeInit!: () => void;
  const initialized = new Promise<void>((resolve) => {
    acknowledgeInit = resolve;
  });
  const activeQuery = createBaseQueryMock(
    vi.fn(() => {
      acknowledgeInit();
      return new Promise<never>(() => {});
    }),
  );
  activeQuery.next.mockResolvedValueOnce({ done: false, value: claudeTurnInit() });
  sdkQueryFactory.mockImplementation(() => activeQuery);
  await session.startTurn("hello");
  await initialized;

  try {
    await session.interrupt();

    const interruptInfoMessages = extractStringLogArgs(spy.info.mock.calls).filter((message) =>
      message.includes("interruptActiveTurn"),
    );
    const interruptDebugMessages = extractStringLogArgs(spy.debug.mock.calls).filter((message) =>
      message.includes("interruptActiveTurn"),
    );

    expect(interruptInfoMessages).toEqual([]);
    expect(interruptDebugMessages).toEqual([]);
    expect(activeQuery.interrupt).toHaveBeenCalledTimes(1);
    expect(activeQuery.return).not.toHaveBeenCalled();
    expect(activeQuery.close).not.toHaveBeenCalled();
    await session.listCommands!();
    expect(sdkQueryFactory).toHaveBeenCalledTimes(1);
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
        asInternals<Parameters<typeof readEventIdentifiers>[0]>(fixture.message),
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

  await Promise.all(
    fixtures.map(async (fixture) => {
      const session = await createSession();
      const internal: {
        handleSystemMessage: (message: Record<string, unknown>) => {
          threadStartedSessionId: string | null;
          notice: AgentTimelineItem | null;
        };
      } = asInternals(session);
      try {
        const started = internal.handleSystemMessage({
          type: "system",
          subtype: "init",
          permissionMode: "default",
          model: "opus",
          ...fixture.payload,
        });
        expect(started).toEqual({
          threadStartedSessionId: fixture.expected,
          notice: null,
        });
        expect(session.describePersistence()?.sessionId).toBe(fixture.expected);
      } finally {
        await session.close();
      }
    }),
  );
});

test("waits for complete JSON values before updating tool input from input_json_delta", async () => {
  const session = await createSession();
  const internal: {
    mapPartialEvent: (event: Record<string, unknown>) => AgentTimelineItem[];
    toolUseCache: Map<string, { input?: Record<string, unknown> }>;
    toolUseIndexToId: Map<number, string>;
    toolUseInputBuffers: Map<string, string>;
  } = asInternals(session);

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
      internal.mapPartialEvent(asInternals<Record<string, unknown>>(fixture.event));
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
  const internal: {
    mapPartialEvent: (event: Record<string, unknown>) => AgentTimelineItem[];
    toolUseCache: Map<string, { input?: Record<string, unknown> }>;
  } = asInternals(session);

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
  const internal: {
    buildToolOutput: (
      content: unknown,
      block: Record<string, unknown>,
      entry: Record<string, unknown> | undefined,
    ) => Record<string, unknown> | undefined;
  } = asInternals(session);

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
        fixture.content,
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

test("Grep tool_result string content flows to a search detail with content", async () => {
  const session = await createSession();
  const internal: {
    buildToolOutput: (
      content: unknown,
      block: Record<string, unknown>,
      entry: Record<string, unknown> | undefined,
    ) => Record<string, unknown> | undefined;
  } = asInternals(session);

  const grepEntry = {
    id: "tool-grep-1",
    name: "Grep",
    server: "Grep",
    classification: "search",
    started: true,
    input: { pattern: "MaskedView", output_mode: "files_with_matches" },
  };

  try {
    const grepContent = "Found 2 files\nsrc/foo.tsx\nsrc/bar.tsx";
    const output = internal.buildToolOutput(
      grepContent,
      {
        type: "tool_result",
        tool_use_id: "tool-grep-1",
        tool_name: "Grep",
        content: grepContent,
        is_error: false,
      },
      grepEntry,
    );

    const { mapClaudeCompletedToolCall } = await import("./tool-call-mapper.js");
    const item = mapClaudeCompletedToolCall({
      callId: "tool-grep-1",
      name: "Grep",
      input: grepEntry.input,
      output: output ?? null,
    });

    expect(item?.detail).toEqual({
      type: "search",
      query: "MaskedView",
      toolName: "grep",
      content: "Found 2 files\nsrc/foo.tsx\nsrc/bar.tsx",
      numFiles: 0,
    });
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
      const emitStderr = () => options.stderr?.(`${stderrMessage}\n`);
      return createBaseQueryMock(
        vi.fn(async () => {
          if (!failed) {
            failed = true;
            setTimeout(emitStderr, 0);
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
    resolveBinary: async () => "/test/claude/bin",
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

      return createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
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
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(capturedOptions[1]).toMatchObject({
      permissionMode: "bypassPermissions",
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

    const internal: {
      handlePermissionRequest: (
        toolName: string,
        input: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<unknown>;
    } = asInternals(session);

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
  const internal: {
    turnState: "idle" | "foreground" | "autonomous";
    nextTurnOrdinal: number;
    routeSdkMessageFromPump: (
      message: Record<string, unknown>,
      activeQuery: QueryMock,
    ) => Promise<void>;
    autonomousTurn: { id: string } | null;
  } = asInternals(session);
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));

  internal.turnState = "idle";
  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  await internal.routeSdkMessageFromPump(
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "AUTO " },
      },
    },
    queryMock,
  );

  const firstRunId = internal.autonomousTurn?.id ?? null;
  expect(firstRunId).toBe("autonomous-turn-1");
  expect(internal.nextTurnOrdinal).toBe(2);

  await internal.routeSdkMessageFromPump(
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "WAKE" },
      },
    },
    queryMock,
  );
  expect(internal.autonomousTurn?.id).toBe(firstRunId);
  expect(internal.nextTurnOrdinal).toBe(2);

  await internal.routeSdkMessageFromPump(
    {
      type: "result",
      subtype: "success",
      usage: buildUsage(),
      total_cost_usd: 0,
    },
    queryMock,
  );
  expect(internal.autonomousTurn).toBeNull();

  await session.close();
});

interface SessionStateInternals {
  turnState: "idle" | "foreground" | "autonomous";
  routeSdkMessageFromPump: (
    message: Record<string, unknown>,
    activeQuery: QueryMock,
  ) => Promise<void>;
  autonomousTurn: { id: string } | null;
  activeForegroundTurnId: string | null;
}

function sessionState(state: "idle" | "running" | "requires_action") {
  return {
    type: "system",
    subtype: "session_state_changed",
    state,
    uuid: `state-${state}`,
    session_id: "sess-1",
  };
}

/** Claude opening a turn of its own. Every main-session turn starts with one. */
function claudeTurnInit() {
  return {
    type: "system",
    subtype: "init",
    session_id: "sess-1",
    permissionMode: "default",
    model: "opus",
  };
}

function successResult() {
  return { type: "result", subtype: "success", usage: buildUsage(), total_cost_usd: 0 };
}

function commandLifecycle(
  commandUuid: string,
  state: "queued" | "started" | "completed" | "cancelled",
) {
  return { type: "command_lifecycle", command_uuid: commandUuid, state };
}

function unboundTextDelta(text: string) {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

// What a background subagent emits on the main stream with no parent tool use id, so by frame
// shape alone each looks like main-session work. Verified on the wire: none arrives inside a turn
// Claude opened, and no result follows any of them.
const helperTaskStarted = {
  type: "system",
  subtype: "task_started",
  task_id: "helper-task",
  tool_use_id: "toolu_helper",
  task_type: "local_agent",
  subagent_type: "general-purpose",
  description: "Background helper",
  is_backgrounded: true,
  uuid: "uuid-task-started",
  session_id: "sess-1",
};
const helperTaskProgress = {
  type: "system",
  subtype: "task_progress",
  task_id: "helper-task",
  tool_use_id: "toolu_helper",
  description: "Background helper",
  usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 900 },
  last_tool_name: "Bash",
  uuid: "uuid-task-progress",
  session_id: "sess-1",
};
// A subagent's own background Bash job completing.
const subagentOwnedTaskNotification = {
  type: "system",
  subtype: "task_notification",
  task_id: "bg-job-of-subagent",
  tool_use_id: "toolu_subagent_bash",
  status: "completed",
  summary: "Background command completed",
  output_file: "/tmp/bg-job-of-subagent.output",
  uuid: "uuid-task-notification",
  session_id: "sess-1",
};
const helperCompleted = {
  type: "system",
  subtype: "task_notification",
  task_id: "helper-task",
  tool_use_id: "toolu_helper",
  status: "completed",
  summary: "Background helper finished",
  output_file: "/tmp/helper-task.output",
  uuid: "uuid-helper-completed",
  session_id: "sess-1",
};
const rateLimitEvent = {
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed" },
  uuid: "uuid-rate-limit",
  session_id: "sess-1",
};

function createPendingQueryMock(): QueryMock {
  return createBaseQueryMock(vi.fn(() => new Promise<never>(() => {})));
}

test("a main-session frame opens no turn until Claude starts one", async () => {
  const session = await createSession();
  const internal: SessionStateInternals = asInternals(session);
  const queryMock = createPendingQueryMock();

  // Main-session output only ever arrives inside a turn Claude opened with system/init, so a
  // stray unbound frame is not the start of one.
  await internal.routeSdkMessageFromPump(unboundTextDelta("stray"), queryMock);
  expect(internal.autonomousTurn).toBeNull();

  // The wake-up case autonomous turns exist for: a completed background subagent makes the main
  // session start a turn of its own, with no prompt from the user.
  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  await internal.routeSdkMessageFromPump(unboundTextDelta("picking this up"), queryMock);
  expect(internal.autonomousTurn?.id).toBe("autonomous-turn-1");

  await internal.routeSdkMessageFromPump(successResult(), queryMock);
  expect(internal.autonomousTurn).toBeNull();

  await session.close();
});

test("a background subagent's frames never open a turn while the main session is idle", async () => {
  sdkQueryFactory.mockImplementation(() => createPendingQueryMock());
  const session = await createSession();
  const internal: SessionStateInternals = asInternals(session);
  const queryMock = createPendingQueryMock();

  // Claude Code 2.1.280 reports "running" for as long as any background subagent is alive.
  await internal.routeSdkMessageFromPump(sessionState("running"), queryMock);
  for (const frame of [
    helperTaskStarted,
    helperTaskProgress,
    subagentOwnedTaskNotification,
    rateLimitEvent,
    helperCompleted,
  ]) {
    await internal.routeSdkMessageFromPump(frame, queryMock);
    expect(internal.autonomousTurn).toBeNull();
    expect(internal.turnState).toBe("idle");
  }

  // The next user message starts its own foreground turn rather than landing on a phantom one.
  const { turnId } = await session.startTurn("PING");
  expect(internal.activeForegroundTurnId).toBe(turnId);
  expect(internal.autonomousTurn).toBeNull();
  expect(internal.turnState).toBe("foreground");

  await session.close();
});

test("Claude waking up after a helper finishes gets an autonomous turn that its result closes", async () => {
  const session = await createSession();
  const internal: SessionStateInternals = asInternals(session);
  const queryMock = createPendingQueryMock();
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  // The helper's completion arrives outside any turn. Claude then starts one to react to it.
  await internal.routeSdkMessageFromPump(helperTaskStarted, queryMock);
  await internal.routeSdkMessageFromPump(helperCompleted, queryMock);
  expect(internal.autonomousTurn).toBeNull();

  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  expect(internal.autonomousTurn?.id).toBe("autonomous-turn-1");
  expect(internal.turnState).toBe("autonomous");

  await internal.routeSdkMessageFromPump(unboundTextDelta("the helper is done"), queryMock);
  await internal.routeSdkMessageFromPump(successResult(), queryMock);
  expect(internal.autonomousTurn).toBeNull();
  expect(internal.turnState).toBe("idle");
  expect(events.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);

  await session.close();
});

test("a steer folded into a turn keeps one turn, and a turn Claude starts after it gets its own", async () => {
  sdkQueryFactory.mockImplementation(() => createPendingQueryMock());
  const session = await createSession();
  const internal: SessionStateInternals = asInternals(session);
  const queryMock = createPendingQueryMock();
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  const { turnId } = await session.startTurn("hello");
  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  // A message pushed mid-turn is folded in at the next tool boundary: Claude acknowledges it, but
  // starts no new turn.
  await internal.routeSdkMessageFromPump(commandLifecycle("folded-steer", "queued"), queryMock);
  await internal.routeSdkMessageFromPump(commandLifecycle("folded-steer", "started"), queryMock);
  expect(internal.activeForegroundTurnId).toBe(turnId);
  expect(internal.autonomousTurn).toBeNull();

  await internal.routeSdkMessageFromPump(successResult(), queryMock);
  expect(internal.activeForegroundTurnId).toBeNull();
  expect(internal.turnState).toBe("idle");

  // A message that arrived while Claude wrote its final answer runs as a turn of its own.
  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  expect(internal.autonomousTurn?.id).toBe("autonomous-turn-2");
  await internal.routeSdkMessageFromPump(successResult(), queryMock);
  expect(internal.autonomousTurn).toBeNull();
  expect(internal.turnState).toBe("idle");
  expect(events.filter((event) => event.type === "turn_started")).toHaveLength(2);
  expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2);

  await session.close();
});

test("session state never opens a turn", async () => {
  const session = await createSession();
  const internal: SessionStateInternals = asInternals(session);
  const queryMock = createPendingQueryMock();
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  // "running" covers background subagents too, so it says nothing about the main session.
  for (const state of ["idle", "running", "requires_action", "idle"] as const) {
    await internal.routeSdkMessageFromPump(sessionState(state), queryMock);
    expect(internal.autonomousTurn).toBeNull();
    expect(internal.turnState).toBe("idle");
  }
  // State frames are bookkeeping, never timeline content.
  expect(events).toEqual([]);

  await session.close();
});

test("an idle session state closes an autonomous turn that no result closed", async () => {
  const session = await createSession();
  const internal: SessionStateInternals = asInternals(session);
  const queryMock = createPendingQueryMock();
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  expect(internal.autonomousTurn?.id).toBe("autonomous-turn-1");

  // Safety net: Claude says nothing at all is running any more.
  await internal.routeSdkMessageFromPump(sessionState("idle"), queryMock);
  expect(internal.autonomousTurn).toBeNull();
  expect(internal.turnState).toBe("idle");
  expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);

  await session.close();
});

test("session state never opens or closes a foreground turn", async () => {
  sdkQueryFactory.mockImplementation(() => createPendingQueryMock());
  const session = await createSession();
  const internal: SessionStateInternals = asInternals(session);
  const queryMock = createPendingQueryMock();

  await internal.routeSdkMessageFromPump(sessionState("idle"), queryMock);
  const { turnId } = await session.startTurn("hello");

  // The send's own running, then an idle that trails the previous turn and lands late.
  await internal.routeSdkMessageFromPump(sessionState("running"), queryMock);
  await internal.routeSdkMessageFromPump(sessionState("idle"), queryMock);
  expect(internal.activeForegroundTurnId).toBe(turnId);
  expect(internal.autonomousTurn).toBeNull();
  expect(internal.turnState).toBe("foreground");

  await internal.routeSdkMessageFromPump(
    { type: "result", subtype: "success", usage: buildUsage(), total_cost_usd: 0 },
    queryMock,
  );
  expect(internal.activeForegroundTurnId).toBeNull();
  expect(internal.turnState).toBe("idle");

  await session.close();
});

interface InterruptInternals extends SessionStateInternals {
  pendingInterruptAbort: boolean;
}

type InterruptibleQueryMock = QueryMock & { cancelAsyncMessage: ReturnType<typeof vi.fn> };

function createInterruptibleQueryMock(): InterruptibleQueryMock {
  return Object.assign(createPendingQueryMock(), {
    cancelAsyncMessage: vi.fn(async () => true),
  });
}

/** The uuid Paseo stamped on the first message it pushed into the SDK input. */
async function readFirstPromptUuid(): Promise<string | null> {
  const input = sdkQueryFactory.mock.calls[0]?.[0] as { prompt: AsyncIterable<unknown> };
  return await createPromptUuidReader(input.prompt)();
}

function abortedResult() {
  return {
    type: "result",
    subtype: "error_during_execution",
    errors: [],
    usage: buildUsage(),
    total_cost_usd: 0,
  };
}

test("an interrupt before Claude starts the message withdraws it instead of interrupting", async () => {
  const queryMock = createInterruptibleQueryMock();
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  const internal: InterruptInternals = asInternals(session);
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.startTurn("hello");
  // Claude has not acknowledged the message yet: no init, no command_lifecycle "started".
  await session.interrupt();

  await vi.waitFor(() => expect(queryMock.cancelAsyncMessage).toHaveBeenCalledTimes(1));
  expect(queryMock.cancelAsyncMessage).toHaveBeenCalledWith(await readFirstPromptUuid());
  expect(queryMock.interrupt).not.toHaveBeenCalled();
  // No result follows an interrupt that never happened, so no flag may wait for one.
  expect(internal.pendingInterruptAbort).toBe(false);
  expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(1);

  await session.close();
});

test("an interrupt after Claude took the message but before it started stops it", async () => {
  const queryMock = createInterruptibleQueryMock();
  // Claude has dequeued the message for its next turn, so withdrawing it is a no-op.
  queryMock.cancelAsyncMessage.mockImplementation(async () => false);
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  const internal: InterruptInternals = asInternals(session);

  await session.startTurn("hello");
  // No command_lifecycle "started" or init has reached Paseo yet.
  await session.interrupt();

  await vi.waitFor(() => expect(queryMock.interrupt).toHaveBeenCalledTimes(1));
  expect(queryMock.cancelAsyncMessage).toHaveBeenCalledWith(await readFirstPromptUuid());
  expect(internal.pendingInterruptAbort).toBe(true);

  await session.close();
});

test("a prompt sent while a stopped prompt is being withdrawn is not withdrawn too", async () => {
  const queryMock = createInterruptibleQueryMock();
  let settleWithdrawal: (cancelled: boolean) => void = () => {};
  queryMock.cancelAsyncMessage.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (settleWithdrawal = resolve)),
  );
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();

  await session.startTurn("first");
  const firstUuid = await readFirstPromptUuid();
  await session.interrupt();
  await vi.waitFor(() => expect(queryMock.cancelAsyncMessage).toHaveBeenCalledTimes(1));

  await session.startTurn("second");
  settleWithdrawal(false);

  await vi.waitFor(() => expect(queryMock.interrupt).toHaveBeenCalledTimes(1));
  expect(queryMock.cancelAsyncMessage).toHaveBeenCalledTimes(1);
  expect(queryMock.cancelAsyncMessage).toHaveBeenCalledWith(firstUuid);

  await session.close();
});

test("an interrupt while only background subagents run never reaches Claude", async () => {
  const queryMock = createInterruptibleQueryMock();
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  const internal: InterruptInternals = asInternals(session);

  await session.startTurn("delegate to a helper");
  const promptUuid = await readFirstPromptUuid();
  await internal.routeSdkMessageFromPump(commandLifecycle(promptUuid ?? "", "started"), queryMock);
  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  await internal.routeSdkMessageFromPump(helperTaskStarted, queryMock);
  await internal.routeSdkMessageFromPump(successResult(), queryMock);
  // The main session is done; its helper keeps working.
  await internal.routeSdkMessageFromPump(sessionState("running"), queryMock);
  await internal.routeSdkMessageFromPump(helperTaskProgress, queryMock);

  // Without perTaskStopAffordance, an interrupt here kills every running helper.
  await session.interrupt();

  expect(queryMock.interrupt).not.toHaveBeenCalled();
  expect(queryMock.cancelAsyncMessage).not.toHaveBeenCalled();
  expect(internal.pendingInterruptAbort).toBe(false);

  await session.close();
});

test("an interrupt during a main turn interrupts Claude once and drops the aborted result", async () => {
  const queryMock = createInterruptibleQueryMock();
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  const internal: InterruptInternals = asInternals(session);
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.startTurn("long task");
  const promptUuid = await readFirstPromptUuid();
  await internal.routeSdkMessageFromPump(commandLifecycle(promptUuid ?? "", "started"), queryMock);
  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);

  await session.interrupt();
  await vi.waitFor(() => expect(queryMock.interrupt).toHaveBeenCalledTimes(1));
  // Claude already started the message, so there is nothing to withdraw.
  expect(queryMock.cancelAsyncMessage).not.toHaveBeenCalled();
  expect(internal.pendingInterruptAbort).toBe(true);

  // A replacement starts before the aborted turn reports its result.
  const { turnId } = await session.startTurn("replacement");
  await internal.routeSdkMessageFromPump(abortedResult(), queryMock);
  expect(internal.activeForegroundTurnId).toBe(turnId);
  expect(internal.pendingInterruptAbort).toBe(false);
  expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);

  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  await internal.routeSdkMessageFromPump(successResult(), queryMock);
  expect(internal.activeForegroundTurnId).toBeNull();
  expect(queryMock.interrupt).toHaveBeenCalledTimes(1);

  await session.close();
});

test("a new turn clears an interrupt flag no result will consume", async () => {
  const session = await createSession();
  const internal: InterruptInternals = asInternals(session);
  const queryMock = createPendingQueryMock();
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  // An interrupt that landed just after its turn had ended: Claude emits no result for it.
  internal.pendingInterruptAbort = true;

  await internal.routeSdkMessageFromPump(claudeTurnInit(), queryMock);
  expect(internal.pendingInterruptAbort).toBe(false);
  expect(internal.autonomousTurn?.id).toBe("autonomous-turn-1");

  // This turn's own failure is reported, not swallowed as the interrupted turn's leftover.
  await internal.routeSdkMessageFromPump(
    { ...abortedResult(), errors: ["API Error: 500 upstream failure"] },
    queryMock,
  );
  expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(1);
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

  const assembler: {
    timelineAssembler: { messages: Map<string, unknown> };
  } = asInternals(session);
  expect(assembler.timelineAssembler.messages.size).toBe(0);

  await session.close();
});
