import { afterEach, describe, expect, test, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as executableUtils from "../../../../utils/executable.js";
import {
  ClaudeAgentClient,
  convertClaudeHistoryEntry,
  normalizeClaudeAskUserQuestionUpdatedInput,
} from "./agent.js";
import type { AgentTimelineItem, AgentUsage, AgentStreamEvent } from "../../agent-sdk-types.js";

interface TestClaudeSession {
  translateMessageToEvents(message: SDKMessage): AgentStreamEvent[];
  convertUsage(message: SDKMessage): AgentUsage | undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("convertClaudeHistoryEntry", () => {
  test("maps user tool results to timeline items", () => {
    const toolUseId = "toolu_test";
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    };

    const stubTimeline: AgentTimelineItem[] = [
      {
        type: "tool_call",
        server: "editor",
        tool: "read_file",
        status: "completed",
      },
    ];

    const mapBlocks = vi.fn().mockReturnValue(stubTimeline);
    const result = convertClaudeHistoryEntry(entry, mapBlocks);

    expect(result).toEqual(stubTimeline);
    expect(mapBlocks).toHaveBeenCalledTimes(1);
    expect(Array.isArray(mapBlocks.mock.calls[0][0])).toBe(true);
  });

  test("returns user messages when no tool blocks exist", () => {
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: "Run npm test",
      },
    };

    expect(convertClaudeHistoryEntry(entry, () => [])).toEqual([
      {
        type: "user_message",
        text: "Run npm test",
      },
    ]);
  });

  test("converts compact boundary metadata variants", () => {
    const fixtures = [
      {
        entry: {
          type: "system",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "manual", preTokens: 12 },
        },
        expected: { trigger: "manual", preTokens: 12 },
      },
      {
        entry: {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 34 },
        },
        expected: { trigger: "manual", preTokens: 34 },
      },
      {
        entry: {
          type: "system",
          subtype: "compact_boundary",
          compactionMetadata: { trigger: "auto", preTokens: 56 },
        },
        expected: { trigger: "auto", preTokens: 56 },
      },
    ] as const;

    for (const fixture of fixtures) {
      expect(convertClaudeHistoryEntry(fixture.entry, () => [])).toEqual([
        {
          type: "compaction",
          status: "completed",
          trigger: fixture.expected.trigger,
          preTokens: fixture.expected.preTokens,
        },
      ]);
    }
  });

  test("skips synthetic user entries", () => {
    const entry = {
      type: "user",
      isSynthetic: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "Base directory for this skill: /tmp/skill" }],
      },
    };

    const mapBlocks = vi.fn().mockReturnValue([]);
    const result = convertClaudeHistoryEntry(entry, mapBlocks);

    expect(result).toEqual([]);
    expect(mapBlocks).not.toHaveBeenCalled();
  });

  test("skips meta user entries from Claude skill loading", () => {
    const entry = {
      type: "user",
      isMeta: true,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /tmp/skill\n\n# Orchestrate\n\nYou are an end-to-end implementation orchestrator.",
          },
        ],
      },
    };

    const mapBlocks = vi.fn().mockReturnValue([]);
    const result = convertClaudeHistoryEntry(entry, mapBlocks);

    expect(result).toEqual([]);
    expect(mapBlocks).not.toHaveBeenCalled();
  });

  test("skips interrupt placeholder transcript noise", () => {
    const interruptEntry = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
    };

    const assistantNoiseEntry = {
      type: "assistant",
      message: {
        role: "assistant",
        content: "No response requested.",
      },
    };

    const mapBlocks = vi
      .fn()
      .mockReturnValue([{ type: "assistant_message", text: "No response requested." }]);

    expect(convertClaudeHistoryEntry(interruptEntry, mapBlocks)).toEqual([]);
    expect(convertClaudeHistoryEntry(assistantNoiseEntry, mapBlocks)).toEqual([]);
  });

  test("skips <local-command-stdout> messages (model switch, /context, etc.)", () => {
    // Real entries from Claude Code JSONL history files
    const modelSwitch = {
      type: "user",
      message: {
        role: "user",
        content: "<local-command-stdout>Set model to claude-opus-4-6</local-command-stdout>",
      },
      userType: "external",
    };

    const modelSwitchWithAnsi = {
      type: "user",
      message: {
        role: "user",
        content:
          "<local-command-stdout>Set model to \u001b[1mopus (claude-opus-4-6)\u001b[22m</local-command-stdout>",
      },
    };

    const contextDump = {
      type: "user",
      message: {
        role: "user",
        content:
          "<local-command-stdout>## Context Usage\n\n**Model:** claude-opus-4-6\n**Tokens:** 19k</local-command-stdout>",
      },
    };

    const planMode = {
      type: "user",
      message: {
        role: "user",
        content: "<local-command-stdout>Enabled plan mode</local-command-stdout>",
      },
    };

    const goodbye = {
      type: "user",
      message: {
        role: "user",
        content: "<local-command-stdout>Bye!</local-command-stdout>",
      },
    };

    const empty = {
      type: "user",
      message: {
        role: "user",
        content: "<local-command-stdout></local-command-stdout>",
      },
    };

    const mapBlocks = vi.fn().mockReturnValue([]);

    expect(convertClaudeHistoryEntry(modelSwitch, mapBlocks)).toEqual([]);
    expect(convertClaudeHistoryEntry(modelSwitchWithAnsi, mapBlocks)).toEqual([]);
    expect(convertClaudeHistoryEntry(contextDump, mapBlocks)).toEqual([]);
    expect(convertClaudeHistoryEntry(planMode, mapBlocks)).toEqual([]);
    expect(convertClaudeHistoryEntry(goodbye, mapBlocks)).toEqual([]);
    expect(convertClaudeHistoryEntry(empty, mapBlocks)).toEqual([]);

    // Real user messages must NOT be filtered
    const realMessage = {
      type: "user",
      message: { role: "user", content: "fix the bug in auth.ts" },
    };
    expect(convertClaudeHistoryEntry(realMessage, mapBlocks)).toEqual([
      { type: "user_message", text: "fix the bug in auth.ts" },
    ]);
  });

  test("maps task notifications to synthetic tool calls", () => {
    const entry = {
      type: "system",
      subtype: "task_notification",
      uuid: "task-note-system-1",
      task_id: "bg-fail-1",
      status: "failed",
      summary: "Background task failed",
      output_file: "/tmp/bg-fail-1.txt",
    };

    expect(convertClaudeHistoryEntry(entry, () => [])).toEqual([
      {
        type: "tool_call",
        callId: "task_notification_task-note-system-1",
        name: "task_notification",
        status: "failed",
        error: { message: "Background task failed" },
        detail: {
          type: "plain_text",
          label: "Background task failed",
          icon: "wrench",
          text: "Background task failed",
        },
        metadata: {
          synthetic: true,
          source: "claude_task_notification",
          taskId: "bg-fail-1",
          status: "failed",
          outputFile: "/tmp/bg-fail-1.txt",
        },
      },
    ]);
  });

  test("maps queue-operation task notifications to synthetic tool calls", () => {
    const entry = {
      type: "queue-operation",
      operation: "enqueue",
      uuid: "task-note-queue-1",
      content: [
        "<task-notification>",
        "<task-id>bg-queue-1</task-id>",
        "<status>completed</status>",
        "<summary>Background task completed</summary>",
        "<output-file>/tmp/bg-queue-1.txt</output-file>",
        "</task-notification>",
      ].join("\n"),
    };

    expect(convertClaudeHistoryEntry(entry, () => [])).toEqual([
      {
        type: "tool_call",
        callId: "task_notification_task-note-queue-1",
        name: "task_notification",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: "Background task completed",
          icon: "wrench",
          text: entry.content,
        },
        metadata: {
          synthetic: true,
          source: "claude_task_notification",
          taskId: "bg-queue-1",
          status: "completed",
          outputFile: "/tmp/bg-queue-1.txt",
        },
      },
    ]);
  });

  test("passes assistant content blocks through to the mapper", () => {
    const entry = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "Here is my answer." },
        ],
      },
    };

    const mappedTimeline = [
      { type: "reasoning", text: "Let me reason about this..." },
      { type: "assistant_message", text: "Here is my answer." },
    ];
    const mapBlocks = vi.fn().mockReturnValue(mappedTimeline);

    expect(convertClaudeHistoryEntry(entry, mapBlocks)).toEqual(mappedTimeline);
    expect(mapBlocks).toHaveBeenCalledWith(entry.message.content);
  });
});

// NOTE: Turn handoff integration tests are covered by the daemon E2E test:
// "interrupting message should produce coherent text without garbling from race condition"
// in daemon.e2e.test.ts which exercises the full flow through the WebSocket API.

describe("ClaudeAgentClient.listModels", () => {
  const logger = createTestLogger();

  test("returns hardcoded claude models", async () => {
    const client = new ClaudeAgentClient({ logger, resolveBinary: async () => "/test/claude/bin" });
    const models = await client.listModels({ cwd: "/tmp/claude-models", force: false });

    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-4-7[1m]",
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
      "claude-opus-4-6",
      "claude-sonnet-4-6[1m]",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);

    for (const model of models) {
      expect(model.provider).toBe("claude");
      expect(model.label.length).toBeGreaterThan(0);
    }

    const defaultModel = models.find((m) => m.isDefault);
    expect(defaultModel?.id).toBe("claude-opus-4-6");
  });
});

describe("ClaudeAgentClient binary resolution", () => {
  const logger = createTestLogger();

  test("uses the replace-command override binary when claude is not on PATH", async () => {
    const customClaudePath = "/path/to/custom-claude";
    vi.spyOn(executableUtils, "findExecutable").mockImplementation(async (name: string) => {
      if (name === "claude") {
        return null;
      }
      if (name === customClaudePath) {
        return customClaudePath;
      }
      return null;
    });

    const queryReturn = vi.fn();
    queryReturn.mockResolvedValue(undefined);
    const queryFactory = vi.fn(() => ({
      close: vi.fn(),
      return: queryReturn,
    }));

    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      runtimeSettings: {
        command: {
          mode: "replace",
          argv: [customClaudePath],
        },
      },
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    await expect(
      (
        session as unknown as {
          ensureQuery(): Promise<unknown>;
        }
      ).ensureQuery(),
    ).resolves.toBeDefined();

    expect(queryFactory.mock.calls[0]?.[0].options.pathToClaudeCodeExecutable).toBe(
      customClaudePath,
    );

    await session.close();
  });
});

describe("normalizeClaudeAskUserQuestionUpdatedInput", () => {
  test("maps frontend header-keyed answers to Claude question text keys", () => {
    expect(
      normalizeClaudeAskUserQuestionUpdatedInput(
        {
          questions: [
            {
              question: "Which provider should I use?",
              header: "Provider",
              options: [],
              multiSelect: false,
            },
          ],
          answers: { Provider: "Claude" },
        },
        undefined,
      ),
    ).toEqual({
      questions: [
        {
          question: "Which provider should I use?",
          header: "Provider",
          options: [],
          multiSelect: false,
        },
      ],
      answers: { "Which provider should I use?": "Claude" },
    });
  });

  test("uses fallback request questions when response only includes answers", () => {
    expect(
      normalizeClaudeAskUserQuestionUpdatedInput(
        {
          answers: { Provider: "Codex" },
        },
        {
          questions: [
            {
              question: "Which provider should I use?",
              header: "Provider",
              options: [],
              multiSelect: false,
            },
          ],
        },
      ),
    ).toEqual({
      questions: [
        {
          question: "Which provider should I use?",
          header: "Provider",
          options: [],
          multiSelect: false,
        },
      ],
      answers: { "Which provider should I use?": "Codex" },
    });
  });

  test("respondToPermission preserves full question input when UI returns answers-only payload", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const request = {
      id: "permission-question-1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: {
        questions: [
          {
            question: "Which provider should I use?",
            header: "Provider",
            options: [],
            multiSelect: false,
          },
        ],
      },
    };

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      (
        session as unknown as {
          pendingPermissions: Map<
            string,
            {
              request: typeof request;
              resolve: (value: unknown) => void;
              reject: (error: Error) => void;
            }
          >;
        }
      ).pendingPermissions.set(request.id, {
        request,
        resolve,
        reject,
      });
    });

    try {
      await session.respondToPermission(request.id, {
        behavior: "allow",
        updatedInput: {
          answers: { Provider: "Claude" },
        },
      });

      await expect(resultPromise).resolves.toEqual({
        behavior: "allow",
        updatedInput: {
          questions: [
            {
              question: "Which provider should I use?",
              header: "Provider",
              options: [],
              multiSelect: false,
            },
          ],
          answers: { "Which provider should I use?": "Claude" },
        },
        updatedPermissions: undefined,
      });
    } finally {
      await session.close();
    }
  });
});

describe("ClaudeAgentSession context window usage", () => {
  const logger = createTestLogger();

  async function createSessionForTest(): Promise<TestClaudeSession> {
    const client = new ClaudeAgentClient({ logger, resolveBinary: async () => "/test/claude/bin" });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });
    return session as unknown as TestClaudeSession;
  }

  function createQueryFactoryForTurns(turns: Array<Array<Record<string, unknown>>>) {
    return vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const queuedMessages: Array<Record<string, unknown>> = [];
      const waiters: Array<() => void> = [];
      let turnIndex = 0;
      const closedRef = { value: false };

      function wakeNextWaiter() {
        const waiter = waiters.shift();
        waiter?.();
      }

      function enqueue(message: Record<string, unknown>) {
        queuedMessages.push(message);
        wakeNextWaiter();
      }

      void (async () => {
        for await (const _prompt of prompt) {
          const turnMessages = turns[turnIndex] ?? [];
          turnIndex += 1;
          for (const message of turnMessages) {
            enqueue(message);
          }
        }
        closedRef.value = true;
        wakeNextWaiter();
      })();

      return {
        next: vi.fn(async () => {
          while (queuedMessages.length === 0 && !closedRef.value) {
            await new Promise<void>((resolve) => {
              waiters.push(resolve);
            });
          }
          if (queuedMessages.length === 0) {
            return { done: true, value: undefined };
          }
          return { done: false, value: queuedMessages.shift() };
        }),
        interrupt: vi.fn(async () => undefined),
        return: vi.fn(async () => {
          closedRef.value = true;
          wakeNextWaiter();
          return undefined;
        }),
        close: vi.fn(() => {
          closedRef.value = true;
          wakeNextWaiter();
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
    });
  }

  test("passes persistSession through to the Claude SDK query options", async () => {
    const createResultTurn = (sessionId: string) => [
      {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        permissionMode: "default",
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 10,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: null,
        total_cost_usd: 0,
        usage: {},
        permission_denials: [],
        uuid: `${sessionId}-result`,
        session_id: sessionId,
      },
    ];

    const nonPersistedQueryFactory = createQueryFactoryForTurns([createResultTurn("session-1")]);
    const nonPersistedClient = new ClaudeAgentClient({
      logger,
      queryFactory: nonPersistedQueryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const nonPersistedSession = await nonPersistedClient.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      undefined,
      { persistSession: false },
    );
    await nonPersistedSession.run("turn");
    await nonPersistedSession.close();

    expect(nonPersistedQueryFactory.mock.calls[0]?.[0].options.persistSession).toBe(false);

    const persistedQueryFactory = createQueryFactoryForTurns([createResultTurn("session-2")]);
    const persistedClient = new ClaudeAgentClient({
      logger,
      queryFactory: persistedQueryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const persistedSession = await persistedClient.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      undefined,
      { persistSession: true },
    );
    await persistedSession.run("turn");
    await persistedSession.close();

    expect(persistedQueryFactory.mock.calls[0]?.[0].options.persistSession).toBe(true);
  });

  test("convertUsage includes contextWindowMaxTokens and derives used tokens from result usage as initial fallback", async () => {
    const session = await createSessionForTest();

    const usage = session.convertUsage(
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 5,
          output_tokens: 7,
        },
        total_cost_usd: 0.12,
      },
      {
        "claude-sonnet-4-6": { contextWindow: 200_000 },
        "claude-opus-4-6": { contextWindow: 1_000_000 },
      },
    );

    expect(usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 7,
      totalCostUsd: 0.12,
      contextWindowMaxTokens: 1_000_000,
      contextWindowUsedTokens: 22,
    });
  });

  test("contextWindowUsedTokens falls back to result usage when no task_progress was received", async () => {
    const session = await createSessionForTest();

    const usage = session.convertUsage({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
        output_tokens: 7,
      },
      total_cost_usd: 0.12,
    });

    expect(usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 7,
      totalCostUsd: 0.12,
      contextWindowUsedTokens: 25,
    });
  });

  test("contextWindowUsedTokens is populated from task_progress usage data", async () => {
    const session = await createSessionForTest();

    session.translateMessageToEvents({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      description: "Processing",
      usage: {
        total_tokens: 999,
        tool_uses: 1,
        duration_ms: 50,
        input_tokens: 345,
        cache_read_input_tokens: 55,
      },
      uuid: "task-progress-1",
      session_id: "session-1",
    });

    const events = session.translateMessageToEvents({
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 75,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: null,
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 5,
        output_tokens: 7,
      },
      modelUsage: {
        "claude-sonnet-4-6": { contextWindow: 200_000 },
      },
      permission_denials: [],
      uuid: "result-1",
      session_id: "session-1",
    });

    expect(events).toContainEqual({
      type: "turn_completed",
      provider: "claude",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 7,
        totalCostUsd: 0.25,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 999,
      },
    });
  });

  test("task_progress emits a usage_updated event", async () => {
    const session = await createSessionForTest();

    const events = session.translateMessageToEvents({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      description: "Processing",
      usage: {
        total_tokens: 999,
        tool_uses: 1,
        duration_ms: 50,
      },
      uuid: "task-progress-1",
      session_id: "session-1",
    });

    expect(events).toContainEqual({
      type: "usage_updated",
      provider: "claude",
      usage: {
        contextWindowUsedTokens: 999,
      },
    });
  });

  test("task_notification emits a usage_updated event", async () => {
    const session = await createSessionForTest();

    const events = session.translateMessageToEvents({
      type: "system",
      subtype: "task_notification",
      uuid: "task-note-1",
      task_id: "task-1",
      status: "running",
      summary: "Background task still running",
      usage: {
        total_tokens: 777,
        tool_uses: 1,
        duration_ms: 50,
      },
      session_id: "session-1",
    } as unknown as SDKMessage);

    expect(events).toContainEqual({
      type: "usage_updated",
      provider: "claude",
      usage: {
        contextWindowUsedTokens: 777,
      },
    });
  });

  test("message_start stream events emit usage_updated with per-request usage", async () => {
    const session = await createSessionForTest();

    const events = session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);

    expect(events).toContainEqual({
      type: "usage_updated",
      provider: "claude",
      usage: {
        contextWindowUsedTokens: 150,
      },
    });
  });

  test("message_delta stream events update per-request usage", async () => {
    const session = await createSessionForTest();

    session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);

    const events = session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: {
          output_tokens: 25,
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);

    expect(events).toContainEqual({
      type: "usage_updated",
      provider: "claude",
      usage: {
        contextWindowUsedTokens: 175,
      },
    });
  });

  test("task_progress usage takes priority over derived result usage", async () => {
    const session = await createSessionForTest();

    session.translateMessageToEvents({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      description: "Processing",
      usage: {
        total_tokens: 999,
        tool_uses: 1,
        duration_ms: 50,
        input_tokens: 345,
        cache_read_input_tokens: 55,
      },
      uuid: "task-progress-1",
      session_id: "session-1",
    });

    const usage = session.convertUsage({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
        output_tokens: 7,
      },
      total_cost_usd: 0.12,
    });

    expect(usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 7,
      totalCostUsd: 0.12,
      contextWindowUsedTokens: 999,
    });
  });

  test("contextWindowUsedTokens persists across turns from last task_progress", async () => {
    const queryFactory = createQueryFactoryForTurns([
      [
        {
          type: "system",
          subtype: "init",
          session_id: "session-1",
          permissionMode: "default",
          model: "claude-sonnet-4-6",
        },
        {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          description: "Processing",
          usage: {
            total_tokens: 999,
            tool_uses: 1,
            duration_ms: 50,
            input_tokens: 345,
            cache_read_input_tokens: 55,
          },
          uuid: "task-progress-1",
          session_id: "session-1",
        },
        {
          type: "result",
          subtype: "success",
          duration_ms: 100,
          duration_api_ms: 75,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: null,
          total_cost_usd: 0.25,
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 5,
            output_tokens: 7,
          },
          modelUsage: {
            "claude-sonnet-4-6": { contextWindow: 200_000 },
          },
          permission_denials: [],
          uuid: "result-1",
          session_id: "session-1",
        },
      ],
      [
        {
          type: "result",
          subtype: "success",
          duration_ms: 110,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          result: "still done",
          stop_reason: null,
          total_cost_usd: 0.1,
          usage: {
            input_tokens: 11,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 6,
            output_tokens: 8,
          },
          modelUsage: {
            "claude-sonnet-4-6": { contextWindow: 200_000 },
          },
          permission_denials: [],
          uuid: "result-2",
          session_id: "session-1",
        },
      ],
    ]);
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    try {
      const firstTurn = await session.run("turn 1");
      const secondTurn = await session.run("turn 2");

      expect(firstTurn.usage).toEqual({
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 7,
        totalCostUsd: 0.25,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 999,
      });
      // Turn 2 has no task_progress, so contextWindowUsedTokens retains the
      // last known value from turn 1 rather than deriving from accumulated
      // result.usage (which would be incorrect — those are session-level totals).
      expect(secondTurn.usage).toEqual({
        inputTokens: 11,
        cachedInputTokens: 6,
        outputTokens: 8,
        totalCostUsd: 0.1,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 999,
      });
    } finally {
      await session.close();
    }
  });

  test("convertUsage derives used tokens from result usage as fallback when task_progress is missing", async () => {
    const session = await createSessionForTest();

    const usage = session.convertUsage({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 5,
        output_tokens: 7,
      },
      total_cost_usd: 0.12,
    });

    expect(usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 7,
      totalCostUsd: 0.12,
      contextWindowUsedTokens: 22,
    });
  });

  test("convertUsage uses per-request stream usage when no task_progress is available", async () => {
    const session = await createSessionForTest();

    session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);
    session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: {
          output_tokens: 25,
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);

    const usage = session.convertUsage({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 5,
        output_tokens: 7,
      },
      total_cost_usd: 0.12,
    });

    expect(usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 7,
      totalCostUsd: 0.12,
      contextWindowUsedTokens: 175,
    });
  });

  test("per-request stream usage is not cumulative across API calls in a turn", async () => {
    const session = await createSessionForTest();

    session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);
    session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: {
          output_tokens: 25,
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);

    const secondStartEvents = session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 40,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 10,
          },
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);

    expect(secondStartEvents).toContainEqual({
      type: "usage_updated",
      provider: "claude",
      usage: {
        contextWindowUsedTokens: 55,
      },
    });

    session.translateMessageToEvents({
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: {
          output_tokens: 7,
        },
      },
      session_id: "session-1",
    } as unknown as SDKMessage);

    const usage = session.convertUsage({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 5,
        output_tokens: 7,
      },
      total_cost_usd: 0.12,
    });

    expect(usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 7,
      totalCostUsd: 0.12,
      contextWindowUsedTokens: 62,
    });
  });
});
