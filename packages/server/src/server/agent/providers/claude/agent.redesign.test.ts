import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  const internal: {
    query: {
      interrupt: () => Promise<void>;
      return?: () => Promise<void>;
      close?: () => void;
    } | null;
    input: { end: () => void } | null;
    queryRestartNeeded: boolean;
    interruptActiveTurn: () => Promise<void>;
  } = asInternals(session);
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

type RedesignTestSession = Awaited<ReturnType<typeof createSession>>;

function exitPlanModeTranscript(
  toolUseId: string,
  planText: string,
  result: { content: string; isError?: boolean },
): Record<string, unknown>[] {
  return [
    {
      type: "assistant",
      uuid: `assistant-${toolUseId}`,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: toolUseId, name: "ExitPlanMode", input: { plan: planText } },
        ],
      },
    },
    {
      type: "user",
      uuid: `user-${toolUseId}`,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          },
        ],
      },
    },
  ];
}

interface ExitPlanModeCallEntry {
  planText: string | null;
  supersededEmitted: boolean;
}

// Registers a plan the way the live path does: the permission callback fires from canUseTool
// before the complete assistant message reaches handleToolUseStart, so this is routinely the
// only write that lands before the turn is canceled.
function rememberPlan(session: RedesignTestSession, toolUseId: string, planText: string | null) {
  asInternals<{
    rememberExitPlanModeCall: (id: string, text: string | null) => void;
  }>(session).rememberExitPlanModeCall(toolUseId, planText);
}

function exitPlanModeCalls(session: RedesignTestSession): Map<string, ExitPlanModeCallEntry> {
  return asInternals<{ exitPlanModeCalls: Map<string, ExitPlanModeCallEntry> }>(session)
    .exitPlanModeCalls;
}

// Swaps pushToolCall for a collector so flush behaviour can be read without standing up the
// full event pipeline.
function capturePushedToolCalls(session: RedesignTestSession): AgentTimelineItem[] {
  const pushed: AgentTimelineItem[] = [];
  (
    session as unknown as {
      pushToolCall: (item: AgentTimelineItem | null, items?: AgentTimelineItem[]) => void;
    }
  ).pushToolCall = (item, items) => {
    if (!item) return;
    // Mirror the real signature: with a target array the item is collected there instead of
    // being emitted, which is how handleToolResult returns its items to the caller.
    if (items) {
      items.push(item);
      return;
    }
    pushed.push(item);
  };
  return pushed;
}

async function replayHistoryPlanCard(
  session: RedesignTestSession,
  entries: Record<string, unknown>[],
): Promise<Extract<AgentTimelineItem, { type: "tool_call" }> | undefined> {
  asInternals<{ ingestPersistedHistory: (content: string) => void }>(
    session,
  ).ingestPersistedHistory(entries.map((entry) => JSON.stringify(entry)).join("\n"));
  // The plan replays as a running plan_approval (the tool_use) that flips to a resolved one
  // (the tool_result); return the resolved (terminal) card.
  let resolved: Extract<AgentTimelineItem, { type: "tool_call" }> | undefined;
  for await (const event of session.streamHistory()) {
    if (
      event.type === "timeline" &&
      event.item.type === "tool_call" &&
      event.item.name === "plan_approval" &&
      event.item.status !== "running"
    ) {
      resolved = event.item;
    }
  }
  return resolved;
}

test("replays an approved ExitPlanMode from the transcript as a completed plan card", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const planText = "# Ship it\n\n- step one\n- step two";
    const card = await replayHistoryPlanCard(
      session,
      exitPlanModeTranscript("toolu_approved", planText, {
        content: "User has approved your plan. You can now start coding.",
      }),
    );
    expect(card).toBeDefined();
    expect(card).toMatchObject({ status: "completed", detail: { type: "plan", text: planText } });
  } finally {
    await session.close();
  }
});

test("replays a rejected ExitPlanMode from the transcript as a failed plan card", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const planText = "# Maybe later\n\n- do the thing";
    const card = await replayHistoryPlanCard(
      session,
      exitPlanModeTranscript("toolu_rejected", planText, {
        content: "Denied by user",
        isError: true,
      }),
    );
    expect(card).toBeDefined();
    expect(card).toMatchObject({ status: "failed", detail: { type: "plan", text: planText } });
  } finally {
    await session.close();
  }
});

test("replays an interrupted ExitPlanMode from the transcript as a canceled plan card", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const planText = "# On second thought\n\n- never mind";
    const card = await replayHistoryPlanCard(
      session,
      exitPlanModeTranscript("toolu_interrupted", planText, {
        content: "[Request interrupted by user for tool use]",
        isError: true,
      }),
    );
    expect(card).toBeDefined();
    expect(card).toMatchObject({ status: "canceled", detail: { type: "plan", text: planText } });
  } finally {
    await session.close();
  }
});

test("resolves an interrupted live plan to a plan card (not a failed Tool)", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const internal = asInternals<{
      handleToolResult: (block: Record<string, unknown>, items: AgentTimelineItem[]) => void;
    }>(session);
    // The running plan_approval (pushed by handleToolUseStart) registered the plan text.
    rememberPlan(session, "toolu_interrupted_plan", "# Do the thing");
    const items: AgentTimelineItem[] = [];
    // Interrupted plan: the tool_result arrives orphaned (cache cleared by the turn restart).
    internal.handleToolResult(
      {
        type: "tool_result",
        tool_use_id: "toolu_interrupted_plan",
        is_error: true,
        content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      },
      items,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      name: "plan_approval",
      detail: { type: "plan", text: "# Do the thing" },
    });
  } finally {
    await session.close();
  }
});

test("still renders a normal orphaned failed tool_result as a tool call", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const internal = asInternals<{
      flushPendingToolCalls: () => void;
      handleToolResult: (block: Record<string, unknown>, items: AgentTimelineItem[]) => void;
    }>(session);
    // A plan in the registry must not make every later orphaned result look like a plan.
    rememberPlan(session, "toolu_unrelated_plan", "# Unrelated plan");
    internal.flushPendingToolCalls();
    const items: AgentTimelineItem[] = [];
    internal.handleToolResult(
      {
        type: "tool_result",
        tool_use_id: "toolu_some_other_tool",
        is_error: true,
        content: "boom",
      },
      items,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "tool_call", status: "failed" });
    expect(items[0]).not.toMatchObject({ name: "plan_approval" });
  } finally {
    await session.close();
  }
});

test("resolves the plan text from planFilePath when input.plan is empty (CC 2.0.51+)", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-claude-"));
  const plansDir = path.join(configDir, "plans");
  fs.mkdirSync(plansDir);
  const planFile = path.join(plansDir, "plan.md");
  fs.writeFileSync(planFile, "# Plan from file\n\n- step one");
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const internal = asInternals<{
      resolvePlanTextFromToolInput: (input: Record<string, unknown> | null) => string | null;
    }>(session);
    expect(internal.resolvePlanTextFromToolInput({ plan: "", planFilePath: planFile })).toBe(
      "# Plan from file\n\n- step one",
    );
    // Missing file: the read throws and is swallowed -> no recoverable text.
    expect(
      internal.resolvePlanTextFromToolInput({ planFilePath: path.join(plansDir, "gone.md") }),
    ).toBeNull();
    // input.plan wins over the file when present.
    expect(internal.resolvePlanTextFromToolInput({ plan: "inline", planFilePath: planFile })).toBe(
      "inline",
    );
    // A non-regular path (directory) is rejected, not read — guards against FIFO/device paths.
    expect(internal.resolvePlanTextFromToolInput({ planFilePath: plansDir })).toBeNull();
    // An oversized file is not read, so a hostile path can't exhaust memory / stall the loop.
    const hugeFile = path.join(plansDir, "huge.md");
    fs.writeFileSync(hugeFile, "#".repeat(1024 * 1024 + 1));
    expect(internal.resolvePlanTextFromToolInput({ planFilePath: hugeFile })).toBeNull();
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
    await session.close();
  }
});

test("refuses a planFilePath outside the Claude plans directory", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-claude-"));
  const plansDir = path.join(configDir, "plans");
  fs.mkdirSync(plansDir);
  const secret = path.join(configDir, "secret.env");
  fs.writeFileSync(secret, "API_KEY=super-secret");
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const internal = asInternals<{
      resolvePlanTextFromToolInput: (input: Record<string, unknown> | null) => string | null;
    }>(session);
    // A model-named path outside the plans directory is never read, so a plan card can't be
    // used to surface a file the agent's own Read rules would have denied.
    expect(internal.resolvePlanTextFromToolInput({ planFilePath: secret })).toBeNull();
    // Traversal out of the plans directory is rejected too.
    expect(
      internal.resolvePlanTextFromToolInput({
        planFilePath: path.join(plansDir, "..", "secret.env"),
      }),
    ).toBeNull();
    // And a symlink planted inside the plans directory can't redirect the read.
    const link = path.join(plansDir, "link.md");
    fs.symlinkSync(secret, link);
    expect(internal.resolvePlanTextFromToolInput({ planFilePath: link })).toBeNull();
    // A FIFO inside the plans directory is rejected without blocking. Without O_NONBLOCK the
    // open would park the event loop until a writer showed up, which is never.
    if (process.platform !== "win32") {
      const fifo = path.join(plansDir, "fifo.md");
      childProcess.execFileSync("mkfifo", [fifo]);
      expect(internal.resolvePlanTextFromToolInput({ planFilePath: fifo })).toBeNull();
    }
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
    await session.close();
  }
});

test("flushPendingToolCalls resolves an abandoned plan to a dismissed card", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const internal = asInternals<{
      toolUseCache: Map<string, { id: string; name: string; started: boolean; input: unknown }>;
      flushPendingToolCalls: () => void;
    }>(session);
    const pushed = capturePushedToolCalls(session);
    internal.toolUseCache.set("toolu_abandoned", {
      id: "toolu_abandoned",
      name: "ExitPlanMode",
      started: true,
      input: { plan: "# Abandoned plan" },
    });
    rememberPlan(session, "toolu_abandoned", "# Abandoned plan");

    internal.flushPendingToolCalls();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      type: "tool_call",
      name: "plan_approval",
      status: "canceled",
      detail: { type: "plan", text: "# Abandoned plan" },
    });
    // The registry deliberately survives the flush: Claude's tool_result arrives after the
    // turn is canceled and the id is the only thing that still identifies it as a plan.
    expect(exitPlanModeCalls(session).get("toolu_abandoned")).toMatchObject({
      planText: "# Abandoned plan",
      supersededEmitted: true,
    });
  } finally {
    await session.close();
  }
});

test("flushPendingToolCalls dismisses a plan that never reached the tool_use cache", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const internal = asInternals<{ flushPendingToolCalls: () => void }>(session);
    const pushed = capturePushedToolCalls(session);
    // The live shape: the permission fired from canUseTool, so nothing ever populated
    // toolUseCache. The old code emitted nothing at all here.
    rememberPlan(session, "toolu_no_cache_entry", "# Uncached plan");

    internal.flushPendingToolCalls();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      type: "tool_call",
      name: "plan_approval",
      status: "canceled",
      detail: { type: "plan", text: "# Uncached plan" },
    });
  } finally {
    await session.close();
  }
});

test("two flushes emit exactly one dismissed card for the same plan", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const internal = asInternals<{ flushPendingToolCalls: () => void }>(session);
    const pushed = capturePushedToolCalls(session);
    rememberPlan(session, "toolu_double_flush", "# Plan");

    internal.flushPendingToolCalls();
    internal.flushPendingToolCalls();

    expect(pushed).toHaveLength(1);
  } finally {
    await session.close();
  }
});

test("flushPendingToolCalls emits nothing for a plan whose text never resolved", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const internal = asInternals<{ flushPendingToolCalls: () => void }>(session);
    const pushed = capturePushedToolCalls(session);
    rememberPlan(session, "toolu_textless", null);

    internal.flushPendingToolCalls();

    expect(pushed).toEqual([]);
  } finally {
    await session.close();
  }
});

test("the ExitPlanMode registry is bounded and keeps the newest entries", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const max = 32;
    const overflow = 5;
    for (let i = 0; i < max + overflow; i += 1) {
      rememberPlan(session, `toolu_${i}`, `# Plan ${i}`);
    }
    const calls = exitPlanModeCalls(session);
    expect(calls.size).toBe(max);
    expect(calls.has("toolu_0")).toBe(false);
    expect(calls.has(`toolu_${overflow - 1}`)).toBe(false);
    expect(calls.has(`toolu_${overflow}`)).toBe(true);
    expect(calls.has(`toolu_${max + overflow - 1}`)).toBe(true);
  } finally {
    await session.close();
  }
});

test("a later empty registration cannot erase resolved plan text", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    // handlePermissionRequest resolves the text from planFilePath; handleToolUseStart then
    // arrives with an empty input.plan and must not clobber it.
    rememberPlan(session, "toolu_upgrade_only", "# Resolved from file");
    rememberPlan(session, "toolu_upgrade_only", null);
    expect(exitPlanModeCalls(session).get("toolu_upgrade_only")?.planText).toBe(
      "# Resolved from file",
    );
  } finally {
    await session.close();
  }
});

test("a plan rejected by typing a follow-up settles on the same card as a reload", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const internal = asInternals<{
      flushPendingToolCalls: () => void;
      handleToolResult: (block: Record<string, unknown>, items: AgentTimelineItem[]) => void;
    }>(session);
    const planText = "# Dummy Implementation Plan\n\n- step one";
    const pushed = capturePushedToolCalls(session);
    // Typing a follow-up cancels the turn before Claude's tool_result arrives.
    rememberPlan(session, "toolu_typed_reject", planText);
    internal.flushPendingToolCalls();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      name: "plan_approval",
      status: "canceled",
      callId: "toolu_typed_reject",
    });

    // The real tool_result lands after the flush and must flip the card in place.
    const items: AgentTimelineItem[] = [];
    internal.handleToolResult(
      {
        type: "tool_result",
        tool_use_id: "toolu_typed_reject",
        is_error: true,
        content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      },
      items,
    );
    expect(items).toHaveLength(1);
    const live = items[0];
    expect(live).toMatchObject({
      type: "tool_call",
      name: "plan_approval",
      status: "failed",
      callId: "toolu_typed_reject",
      detail: { type: "plan", text: planText },
    });
    // The regression this guards: the result used to fall through to a generic tool row.
    expect(live).not.toMatchObject({ name: "tool" });
    expect(live).not.toMatchObject({ detail: { type: "unknown" } });

    // Live and reload must agree.
    const replayed = await replayHistoryPlanCard(
      session,
      exitPlanModeTranscript("toolu_replayed_reject", planText, {
        content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
        isError: true,
      }),
    );
    expect(replayed).toBeDefined();
    expect(replayed?.status).toBe(
      (live as Extract<AgentTimelineItem, { type: "tool_call" }>).status,
    );
    expect(replayed?.detail).toEqual(
      (live as Extract<AgentTimelineItem, { type: "tool_call" }>).detail,
    );
  } finally {
    await session.close();
  }
});

test("classifies an array-shaped interrupted result as superseded (canceled)", async () => {
  const queryMock = createBaseQueryMock(vi.fn(async () => ({ done: true, value: undefined })));
  sdkQueryFactory.mockImplementation(() => queryMock);
  const session = await createSession();
  try {
    const internal = asInternals<{
      handleToolResult: (block: Record<string, unknown>, items: AgentTimelineItem[]) => void;
    }>(session);
    rememberPlan(session, "toolu_array_interrupt", "# Plan");
    const items: AgentTimelineItem[] = [];
    // Claude commonly sends tool_result content as an array of text blocks.
    internal.handleToolResult(
      {
        type: "tool_result",
        tool_use_id: "toolu_array_interrupt",
        is_error: true,
        content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
      },
      items,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      name: "plan_approval",
      status: "canceled",
    });
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
