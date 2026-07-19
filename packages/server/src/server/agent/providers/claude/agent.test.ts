import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as executableUtils from "../../../../executable-resolution/executable-resolution.js";
import {
  ClaudeAgentClient,
  convertClaudeHistoryEntry,
  normalizeClaudeAskUserQuestionRequestInput,
  normalizeClaudeAskUserQuestionUpdatedInput,
  toClaudeSdkMcpConfig,
} from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentSession, AgentTimelineItem, AgentStreamEvent } from "../../agent-sdk-types.js";

interface TestClaudeSession {
  translateMessageToEvents(message: SDKMessage): AgentStreamEvent[];
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

  test("replays persisted Claude tool results as completed tool calls", () => {
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_persisted",
            content: "done",
          },
        ],
      },
      toolUseResult: {
        stdout: "done",
        stderr: "",
        interrupted: false,
      },
    };

    const completedToolCall: AgentTimelineItem[] = [
      {
        type: "tool_call",
        callId: "toolu_persisted",
        name: "Bash",
        status: "completed",
        detail: {
          type: "shell",
          command: "echo done",
          output: "done",
          exitCode: 0,
        },
        error: null,
      },
    ];

    const mapPersistedToolResultBlocks = (): AgentTimelineItem[] => completedToolCall;

    expect(convertClaudeHistoryEntry(entry, mapPersistedToolResultBlocks)).toEqual(
      completedToolCall,
    );
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

describe("ClaudeAgentClient.fetchCatalog", () => {
  const logger = createTestLogger();

  test("returns hardcoded claude models", async () => {
    const emptyConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-models-empty-"));
    try {
      const client = new ClaudeAgentClient({
        logger,
        resolveBinary: async () => "/test/claude/bin",
        configDir: emptyConfigDir,
      });
      const { models } = await client.fetchCatalog({
        scope: "workspace",
        cwd: "/tmp/claude-models",
        force: false,
      });

      expect(models.map((m) => m.id)).toEqual([
        "claude-fable-5",
        "claude-opus-4-8[1m]",
        "claude-opus-4-8",
        "claude-sonnet-5",
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
      expect(defaultModel?.id).toBe("claude-opus-4-8");
    } finally {
      await fs.rm(emptyConfigDir, { recursive: true, force: true });
    }
  });

  test("exposes Ultra Code on xhigh-capable Claude models", async () => {
    const emptyConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-models-empty-"));
    try {
      const client = new ClaudeAgentClient({
        logger,
        resolveBinary: async () => "/test/claude/bin",
        configDir: emptyConfigDir,
      });
      const { models } = await client.fetchCatalog({
        scope: "workspace",
        cwd: "/tmp/claude-models",
        force: false,
      });
      const getThinkingIds = (modelId: string) => {
        return models.find((model) => model.id === modelId)?.thinkingOptions?.map(({ id }) => id);
      };

      expect(getThinkingIds("claude-fable-5")).toContain("ultracode");
      expect(getThinkingIds("claude-opus-4-8[1m]")).toContain("ultracode");
      expect(getThinkingIds("claude-opus-4-8")).toContain("ultracode");
      expect(getThinkingIds("claude-sonnet-5")).toContain("xhigh");
      expect(getThinkingIds("claude-sonnet-5")).toContain("ultracode");
      expect(getThinkingIds("claude-opus-4-7[1m]")).toContain("ultracode");
      expect(getThinkingIds("claude-opus-4-7")).toContain("ultracode");
      expect(getThinkingIds("claude-sonnet-4-6")).not.toContain("ultracode");
    } finally {
      await fs.rm(emptyConfigDir, { recursive: true, force: true });
    }
  });
});

describe("ClaudeAgentClient binary resolution", () => {
  const logger = createTestLogger();

  test("loads user, project, and local Claude settings", async () => {
    const queryReturn = vi.fn();
    queryReturn.mockResolvedValue(undefined);
    const queryFactory = vi.fn(() => ({
      close: vi.fn(),
      return: queryReturn,
    }));

    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
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

    expect(queryFactory.mock.calls[0]?.[0].options.settingSources).toEqual([
      "user",
      "project",
      "local",
    ]);

    await session.close();
  });

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

describe("ClaudeAgentSession features", () => {
  const logger = createTestLogger();

  function createQueryMock() {
    let endQuery: (() => void) | null = null;
    const queryEnded = new Promise<void>((resolve) => {
      endQuery = resolve;
    });
    const queryReturn = vi.fn(async () => {
      endQuery?.();
    });
    const queryMock = {
      close: vi.fn(),
      return: queryReturn,
      applyFlagSettings: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => undefined),
      [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
        return {
          next: async () => {
            await queryEnded;
            return { value: undefined, done: true };
          },
        };
      },
    };
    const queryFactory = vi.fn(() => queryMock);
    return { queryFactory, queryMock };
  }

  test("lists fast mode only for supported Opus models", async () => {
    const client = new ClaudeAgentClient({ logger, resolveBinary: async () => "/test/claude/bin" });

    await expect(
      client.listFeatures({
        provider: "claude",
        cwd: process.cwd(),
        model: "claude-opus-4-8",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "fast_mode", value: false })]);

    await expect(
      client.listFeatures({
        provider: "claude",
        cwd: process.cwd(),
        model: "claude-opus-4-8[1m]",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "fast_mode", value: false })]);

    await expect(
      client.listFeatures({
        provider: "claude",
        cwd: process.cwd(),
        model: "claude-opus-4-8-20260101",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "fast_mode", value: false })]);

    await expect(
      client.listFeatures({
        provider: "claude",
        cwd: process.cwd(),
        model: "openrouter/anthropic/claude-opus-4-8",
      }),
    ).resolves.toEqual([]);

    await expect(
      client.listFeatures({
        provider: "claude",
        cwd: process.cwd(),
        model: "claude-sonnet-4-6",
      }),
    ).resolves.toEqual([]);
  });

  test("passes initial fast mode through Claude flag settings", async () => {
    const { queryFactory, queryMock } = createQueryMock();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
      featureValues: { fast_mode: true },
    });

    await expect(
      (
        session as unknown as {
          ensureQuery(): Promise<unknown>;
        }
      ).ensureQuery(),
    ).resolves.toBeDefined();

    expect(queryFactory.mock.calls[0]?.[0].options.settings).toMatchObject({ fastMode: true });
    expect(queryMock.applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });

    await session.close();
  });

  test("maps Ultracode to xhigh effort and Claude ultracode settings", async () => {
    const { queryFactory } = createQueryMock();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
      thinkingOptionId: "ultracode",
    });

    await expect(session.startTurn("hello")).resolves.toEqual({
      turnId: expect.stringMatching(/^foreground-turn-/),
    });

    expect(queryFactory.mock.calls[0]?.[0].options).toMatchObject({
      effort: "xhigh",
      thinking: { type: "adaptive" },
      settings: { ultracode: true },
    });

    await session.close();
  });

  test("returns a next-turn notice when changing Claude thinking during an active turn", async () => {
    const { queryFactory } = createQueryMock();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
    });

    await expect(session.startTurn("hello")).resolves.toEqual({
      turnId: expect.stringMatching(/^foreground-turn-/),
    });

    await expect(session.setThinkingOption?.("ultracode")).resolves.toEqual({
      type: "warning",
      message: "Thinking level applies next turn",
    });

    await session.close();
  });

  test("toggles fast mode on the active query without restarting it", async () => {
    const { queryFactory, queryMock } = createQueryMock();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
    });

    await (
      session as unknown as {
        ensureQuery(): Promise<unknown>;
      }
    ).ensureQuery();
    await session.setFeature?.("fast_mode", true);

    expect(queryFactory).toHaveBeenCalledTimes(1);
    expect(queryMock.applyFlagSettings).toHaveBeenLastCalledWith({ fastMode: true });
    expect(queryMock.close).not.toHaveBeenCalled();
    expect(queryMock.return).not.toHaveBeenCalled();

    await session.close();
  });
});

describe("normalizeClaudeAskUserQuestionUpdatedInput", () => {
  test("marks Claude AskUserQuestion options as allowing other answers", () => {
    expect(
      normalizeClaudeAskUserQuestionRequestInput("AskUserQuestion", {
        questions: [
          {
            question: "Which provider should I use?",
            header: "Provider",
            options: [
              { label: "Claude", description: "Use Claude Code" },
              { label: "Codex", description: "Use Codex" },
            ],
            multiSelect: false,
          },
        ],
      }),
    ).toEqual({
      questions: [
        {
          question: "Which provider should I use?",
          header: "Provider",
          options: [
            { label: "Claude", description: "Use Claude Code" },
            { label: "Codex", description: "Use Codex" },
          ],
          multiSelect: false,
          allowOther: true,
        },
      ],
    });
  });

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

  test("respondToPermission maps other answer text back to Claude question keys", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const request = {
      id: "permission-question-2",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: normalizeClaudeAskUserQuestionRequestInput("AskUserQuestion", {
        questions: [
          {
            question: "Which provider should I use?",
            header: "Provider",
            options: [
              { label: "Claude", description: "Use Claude Code" },
              { label: "Codex", description: "Use Codex" },
            ],
            multiSelect: false,
          },
        ],
      }),
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
          answers: { Provider: "Use both" },
        },
      });

      await expect(resultPromise).resolves.toEqual({
        behavior: "allow",
        updatedInput: {
          questions: [
            {
              question: "Which provider should I use?",
              header: "Provider",
              options: [
                { label: "Claude", description: "Use Claude Code" },
                { label: "Codex", description: "Use Codex" },
              ],
              multiSelect: false,
            },
          ],
          answers: { "Which provider should I use?": "Use both" },
        },
        updatedPermissions: undefined,
      });
    } finally {
      await session.close();
    }
  });
});

describe("ClaudeAgentClient.listImportableSessions", () => {
  test("shows Claude slash command prompts without transcript tags", async () => {
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-import-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;

    try {
      const commandSessionId = "session-command-import";
      const argsSessionId = "session-command-args-import";
      const cwd = "/tmp/paseo-test-claude-import";
      const sanitized = cwd.replace(/[\\/._:]/g, "-");
      const projectDir = path.join(tmpConfigDir, "projects", sanitized);
      await fs.mkdir(projectDir, { recursive: true });
      const commandSessionFile = path.join(projectDir, `${commandSessionId}.jsonl`);
      const argsSessionFile = path.join(projectDir, `${argsSessionId}.jsonl`);
      await fs.writeFile(
        commandSessionFile,
        `${JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          type: "user",
          message: {
            role: "user",
            content:
              "<command-message>caveman:caveman</command-message>\n<command-name>/caveman:caveman</command-name>",
          },
          cwd,
          sessionId: commandSessionId,
        })}\n`,
        "utf-8",
      );
      await fs.writeFile(
        argsSessionFile,
        `${JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          type: "user",
          message: {
            role: "user",
            content:
              "<command-message>diagnose</command-message>\n<command-name>/diagnose</command-name>\n<command-args>recently the PR data does not update</command-args>",
          },
          cwd,
          sessionId: argsSessionId,
        })}\n`,
        "utf-8",
      );
      await fs.utimes(
        commandSessionFile,
        new Date("2026-06-12T10:00:00.000Z"),
        new Date("2026-06-12T10:00:00.000Z"),
      );
      await fs.utimes(
        argsSessionFile,
        new Date("2026-06-12T11:00:00.000Z"),
        new Date("2026-06-12T11:00:00.000Z"),
      );

      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => "/test/claude/bin",
      });

      await expect(client.listImportableSessions({ limit: 2 })).resolves.toEqual([
        {
          providerHandleId: argsSessionId,
          cwd,
          title: "/diagnose recently the PR data does not update",
          firstPromptPreview: "/diagnose recently the PR data does not update",
          lastPromptPreview: "/diagnose recently the PR data does not update",
          lastActivityAt: new Date("2026-06-12T11:00:00.000Z"),
        },
        {
          providerHandleId: commandSessionId,
          cwd,
          title: "/caveman:caveman",
          firstPromptPreview: "/caveman:caveman",
          lastPromptPreview: "/caveman:caveman",
          lastActivityAt: new Date("2026-06-12T10:00:00.000Z"),
        },
      ]);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true });
    }
  });
});

describe("ClaudeAgentSession context window usage", () => {
  const logger = createTestLogger();

  interface QueryFactoryForTurnsOptions {
    getContextUsage?: ReturnType<typeof vi.fn>;
    model?: string;
  }

  async function createSessionForTest(): Promise<TestClaudeSession> {
    const client = new ClaudeAgentClient({ logger, resolveBinary: async () => "/test/claude/bin" });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });
    return session as unknown as TestClaudeSession;
  }

  async function createSessionForTurns(
    turns: Array<Array<Record<string, unknown>>>,
    options?: QueryFactoryForTurnsOptions,
  ): Promise<AgentSession> {
    const client = new ClaudeAgentClient({
      logger,
      queryFactory: createQueryFactoryForTurns(turns, options),
      resolveBinary: async () => "/test/claude/bin",
    });
    return await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: options?.model,
    });
  }

  async function collectStreamEvents(session: AgentSession, prompt = "turn") {
    const events: AgentStreamEvent[] = [];
    for await (const event of streamSession(session, prompt)) {
      events.push(event);
    }
    return events;
  }

  function createQueryFactoryForTurns(
    turns: Array<Array<Record<string, unknown>>>,
    options?: QueryFactoryForTurnsOptions,
  ) {
    return vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const queuedMessages: Array<Record<string, unknown>> = [];
      const waiters: Array<() => void> = [];
      let turnIndex = 0;
      const closedRef = { value: false };
      const getContextUsage = options?.getContextUsage ?? vi.fn(async () => undefined);

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
        getContextUsage,
        supportedModels: vi.fn(async () => []),
        supportedCommands: vi.fn(async () => []),
        rewindFiles: vi.fn(async () => ({ canRewind: true })),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    });
  }

  function createInitMessage(sessionId = "session-1"): Record<string, unknown> {
    return {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      permissionMode: "default",
      model: "claude-sonnet-4-6",
    };
  }

  function createSuccessResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
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
      ...overrides,
    };
  }

  function createMessageStartEvent(
    usage: Record<string, unknown> = {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    },
  ): Record<string, unknown> {
    return {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { usage },
      },
      session_id: "session-1",
    };
  }

  function createMessageDeltaEvent(outputTokens: number): Record<string, unknown> {
    return {
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: {
          output_tokens: outputTokens,
        },
      },
      session_id: "session-1",
    };
  }

  function createAgentToolStartEvent(): Record<string, unknown> {
    return {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu-agent-1",
          name: "Agent",
          input: {
            description: "Check something in a subagent",
            prompt: "Return a short answer",
          },
        },
      },
      session_id: "session-1",
    };
  }

  function createSubagentTaskNotification(): Record<string, unknown> {
    return {
      type: "system",
      subtype: "task_notification",
      uuid: "task-note-1",
      task_id: "task-1",
      tool_use_id: "toolu-agent-1",
      status: "running",
      summary: "Subagent is working",
      usage: {
        total_tokens: 18_876,
        tool_uses: 1,
        duration_ms: 50,
        input_tokens: 12_000,
        cache_read_input_tokens: 6_000,
        output_tokens: 876,
      },
      session_id: "session-1",
    };
  }

  function createCompactBoundary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "manual",
        pre_tokens: 14_990,
        post_tokens: 704,
      },
      uuid: "compact-boundary-1",
      session_id: "session-1",
      ...overrides,
    };
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

  test("classifies Claude root-only commands separately from inline skills", async () => {
    const queryFactory = vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      void prompt;
      return {
        next: async () => ({ done: true, value: undefined }),
        interrupt: async () => undefined,
        return: async () => undefined,
        close: () => undefined,
        setPermissionMode: async () => undefined,
        setModel: async () => undefined,
        getContextUsage: async () => undefined,
        supportedModels: async () => [],
        supportedCommands: async () => [
          {
            name: "taste",
            description: "Use when another skill needs the shared standard. (user)",
            argumentHint: "",
          },
          {
            name: "claude-api",
            description: "Build, debug, and optimize Claude API apps with this skill.",
            argumentHint: "",
          },
          {
            name: "usage",
            description: "Show the total cost and duration of the current session",
            argumentHint: "",
          },
          {
            name: "clear",
            description: "Start a new session with empty context",
            argumentHint: "",
          },
        ],
        rewindFiles: async () => ({ canRewind: true }),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    });
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });

    const commands = await session.listCommands();
    await session.close();

    expect(commands).toEqual([
      {
        name: "claude-api",
        description: "Build, debug, and optimize Claude API apps with this skill.",
        argumentHint: "",
        kind: "skill",
      },
      {
        name: "clear",
        description: "Start a new session with empty context",
        argumentHint: "",
        kind: "command",
      },
      {
        name: "rewind",
        description: "Rewind tracked files to a previous user message",
        argumentHint: "[user_message_uuid]",
      },
      {
        name: "taste",
        description: "Use when another skill needs the shared standard. (user)",
        argumentHint: "",
        kind: "skill",
      },
      {
        name: "usage",
        description: "Show the total cost and duration of the current session",
        argumentHint: "",
        kind: "command",
      },
    ]);
  });

  test("deletes the persisted session jsonl on close when persistSession=false", async () => {
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-persist-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;

    try {
      const sessionId = "session-ephemeral";
      const cwd = "/tmp/paseo-test-claude";
      const sanitized = cwd.replace(/[\\/._:]/g, "-");
      const projectDir = path.join(tmpConfigDir, "projects", sanitized);
      await fs.mkdir(projectDir, { recursive: true });
      const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

      const queryFactory = createQueryFactoryForTurns([
        [
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
        ],
      ]);
      const client = new ClaudeAgentClient({
        logger,
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
      });
      const session = await client.createSession({ provider: "claude", cwd }, undefined, {
        persistSession: false,
      });
      await session.run("turn");

      // Simulate the claude binary writing a session transcript even though we
      // asked the SDK for ephemeral mode (the CLI ignores --no-session-persistence
      // outside --print, see issue context).
      await fs.writeFile(sessionFile, '{"type":"summary"}\n', "utf-8");

      await session.close();

      await expect(fs.access(sessionFile)).rejects.toThrow();
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true });
    }
  });

  test("preserves the persisted session jsonl on close when persistSession is undefined", async () => {
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-persist-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;

    try {
      const sessionId = "session-persistent";
      const cwd = "/tmp/paseo-test-claude";
      const sanitized = cwd.replace(/[\\/._:]/g, "-");
      const projectDir = path.join(tmpConfigDir, "projects", sanitized);
      await fs.mkdir(projectDir, { recursive: true });
      const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

      const queryFactory = createQueryFactoryForTurns([
        [
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
        ],
      ]);
      const client = new ClaudeAgentClient({
        logger,
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
      });
      const session = await client.createSession({ provider: "claude", cwd });
      await session.run("turn");

      await fs.writeFile(sessionFile, '{"type":"summary"}\n', "utf-8");

      await session.close();

      await expect(fs.access(sessionFile)).resolves.toBeUndefined();
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true });
    }
  });

  test("does not probe current context usage after an Agent subagent runs", async () => {
    const getContextUsage = vi.fn(async () => {
      throw new Error("getContextUsage should not be called during result handling");
    });
    const session = await createSessionForTurns(
      [
        [
          createInitMessage(),
          createMessageStartEvent(),
          createAgentToolStartEvent(),
          createSubagentTaskNotification(),
          createMessageDeltaEvent(25),
          createSuccessResult({
            usage: {
              input_tokens: 9_000,
              cache_creation_input_tokens: 300,
              cache_read_input_tokens: 700,
              output_tokens: 400,
            },
          }),
        ],
      ],
      { getContextUsage },
    );

    try {
      const result = await session.run("turn");

      expect(getContextUsage).not.toHaveBeenCalled();
      expect(result.usage).toEqual({
        inputTokens: 9_000,
        cachedInputTokens: 700,
        outputTokens: 400,
        totalCostUsd: 0.25,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 175,
      });
    } finally {
      await session.close();
    }
  });

  test("does not report task notification tokens as parent context usage", async () => {
    const session = await createSessionForTurns([
      [
        createInitMessage(),
        createMessageStartEvent(),
        createAgentToolStartEvent(),
        createSubagentTaskNotification(),
        {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          description: "Subagent progress",
          usage: {
            total_tokens: 9_999,
            tool_uses: 1,
            duration_ms: 50,
          },
          uuid: "task-progress-1",
          session_id: "session-1",
        },
        createMessageDeltaEvent(25),
        createSuccessResult(),
      ],
    ]);

    try {
      const result = await session.run("turn");

      expect(result.usage).toEqual({
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 7,
        totalCostUsd: 0.25,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 175,
      });
    } finally {
      await session.close();
    }
  });

  test("uses parent request usage after a real subagent tool result", async () => {
    const getContextUsage = vi.fn(async () => {
      throw new Error("getContextUsage should not be called during result handling");
    });
    const session = await createSessionForTurns(
      [
        [
          createInitMessage(),
          createMessageStartEvent({
            input_tokens: 3,
            cache_creation_input_tokens: 16_999,
            cache_read_input_tokens: 0,
          }),
          createAgentToolStartEvent(),
          createMessageDeltaEvent(163),
          {
            type: "assistant",
            parent_tool_use_id: "toolu-agent-1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "SUBAGENT_OK" }],
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: 1_182,
                cache_read_input_tokens: 0,
                output_tokens: 8,
              },
            },
            uuid: "subagent-assistant-1",
            session_id: "session-1",
          },
          {
            ...createSubagentTaskNotification(),
            status: "completed",
            summary: "Probe subagent test",
            usage: {
              total_tokens: 1_193,
              tool_uses: 0,
            },
          },
          {
            type: "user",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu-agent-1",
                  content: [
                    { type: "text", text: "SUBAGENT_OK" },
                    {
                      type: "text",
                      text: "agentId: subagent-1\n<usage>subagent_tokens: 1194\ntool_uses: 0</usage>",
                    },
                  ],
                },
              ],
            },
            uuid: "subagent-tool-result-1",
            session_id: "session-1",
          },
          createMessageStartEvent({
            input_tokens: 1,
            cache_creation_input_tokens: 253,
            cache_read_input_tokens: 16_999,
          }),
          createMessageDeltaEvent(8),
          createSuccessResult({
            usage: {
              input_tokens: 4,
              cache_creation_input_tokens: 17_252,
              cache_read_input_tokens: 16_999,
              output_tokens: 171,
              iterations: [
                {
                  input_tokens: 1,
                  cache_creation_input_tokens: 253,
                  cache_read_input_tokens: 16_999,
                  output_tokens: 8,
                },
              ],
            },
            modelUsage: {
              "claude-sonnet-4-6": {
                inputTokens: 7,
                outputTokens: 180,
                cacheReadInputTokens: 16_999,
                cacheCreationInputTokens: 18_434,
                contextWindow: 200_000,
              },
            },
          }),
        ],
      ],
      { getContextUsage },
    );

    try {
      const result = await session.run("turn");

      expect(getContextUsage).not.toHaveBeenCalled();
      expect(result.usage).toEqual({
        inputTokens: 4,
        cachedInputTokens: 16_999,
        outputTokens: 171,
        totalCostUsd: 0.25,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 17_261,
      });
    } finally {
      await session.close();
    }
  });

  test("falls back to the active result iteration when current and stream usage are unavailable", async () => {
    const session = await createSessionForTurns([
      [
        createInitMessage(),
        createSuccessResult({
          usage: {
            input_tokens: 5_000,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 600,
            output_tokens: 700,
            iterations: [
              {
                input_tokens: 100,
                cache_creation_input_tokens: 10,
                cache_read_input_tokens: 20,
                output_tokens: 30,
              },
              {
                input_tokens: 2,
                cache_creation_input_tokens: 10,
                cache_read_input_tokens: 100,
                output_tokens: 5,
              },
            ],
          },
        }),
      ],
    ]);

    try {
      const result = await session.run("turn");

      expect(result.usage).toEqual({
        inputTokens: 5_000,
        cachedInputTokens: 600,
        outputTokens: 700,
        totalCostUsd: 0.25,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 117,
      });
    } finally {
      await session.close();
    }
  });

  test("does not use aggregate result totals after the first result turn", async () => {
    const session = await createSessionForTurns([
      [
        createInitMessage(),
        createMessageStartEvent(),
        createMessageDeltaEvent(25),
        createSuccessResult(),
      ],
      [
        createSuccessResult({
          total_cost_usd: 0.1,
          usage: {
            input_tokens: 1_000,
            cache_read_input_tokens: 200,
            output_tokens: 300,
          },
          uuid: "result-2",
        }),
      ],
    ]);

    try {
      const firstTurn = await session.run("turn 1");
      const secondTurn = await session.run("turn 2");

      expect(firstTurn.usage).toEqual({
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 7,
        totalCostUsd: 0.25,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 175,
      });
      expect(secondTurn.usage).toEqual({
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 300,
        totalCostUsd: 0.1,
        contextWindowMaxTokens: 200_000,
      });
    } finally {
      await session.close();
    }
  });

  test("message_start stream events emit usage_updated with per-request usage", async () => {
    const session = await createSessionForTurns([
      [createInitMessage(), createMessageStartEvent(), createSuccessResult()],
    ]);

    try {
      const events = await collectStreamEvents(session);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          provider: "claude",
          usage: {
            contextWindowUsedTokens: 150,
          },
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("selected Claude models seed active context window usage with max tokens", async () => {
    const session = await createSessionForTurns(
      [[createInitMessage(), createMessageStartEvent(), createSuccessResult()]],
      { model: "claude-sonnet-4-6" },
    );

    try {
      const events = await collectStreamEvents(session);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          provider: "claude",
          usage: {
            contextWindowMaxTokens: 200_000,
            contextWindowUsedTokens: 150,
          },
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("native 1M Claude models seed active context window usage from the catalog", async () => {
    const session = await createSessionForTurns(
      [[createInitMessage(), createMessageStartEvent(), createSuccessResult()]],
      { model: "claude-sonnet-5" },
    );

    try {
      const events = await collectStreamEvents(session);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          provider: "claude",
          usage: {
            contextWindowMaxTokens: 1_000_000,
            contextWindowUsedTokens: 150,
          },
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("message_delta stream events update per-request usage", async () => {
    const session = await createSessionForTurns([
      [
        createInitMessage(),
        createMessageStartEvent(),
        createMessageDeltaEvent(25),
        createSuccessResult(),
      ],
    ]);

    try {
      const events = await collectStreamEvents(session);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          provider: "claude",
          usage: {
            contextWindowUsedTokens: 175,
          },
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("per-request stream usage is not cumulative across API calls in a turn", async () => {
    const session = await createSessionForTurns([
      [
        createInitMessage(),
        createMessageStartEvent(),
        createMessageDeltaEvent(25),
        createMessageStartEvent({
          input_tokens: 40,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 10,
        }),
        createMessageDeltaEvent(7),
        createSuccessResult(),
      ],
    ]);

    try {
      const events = await collectStreamEvents(session);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          provider: "claude",
          usage: {
            contextWindowUsedTokens: 55,
          },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          provider: "claude",
          usage: {
            contextWindowUsedTokens: 62,
          },
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("manual compact boundary updates context usage from post tokens", async () => {
    const session = await createSessionForTurns([
      [
        createInitMessage(),
        createMessageStartEvent(),
        createMessageDeltaEvent(25),
        createCompactBoundary(),
        createSuccessResult({
          total_cost_usd: 0.04,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            iterations: [],
          },
        }),
      ],
    ]);

    try {
      const events = await collectStreamEvents(session, "/compact");

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          provider: "claude",
          usage: {
            contextWindowUsedTokens: 704,
          },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn_completed",
          provider: "claude",
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0.04,
            contextWindowMaxTokens: 200_000,
            contextWindowUsedTokens: 704,
          },
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("zero-token stream events after compact keep post-token usage", async () => {
    const session = await createSessionForTurns([
      [
        createInitMessage(),
        createMessageStartEvent(),
        createMessageDeltaEvent(25),
        createCompactBoundary(),
        createMessageStartEvent({
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
        createMessageDeltaEvent(0),
        createSuccessResult({
          total_cost_usd: 0.04,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            iterations: [],
          },
        }),
      ],
    ]);

    try {
      const events = await collectStreamEvents(session, "/compact");

      expect(
        events.filter(
          (event) => event.type === "usage_updated" && event.usage.contextWindowUsedTokens === 0,
        ),
      ).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn_completed",
          provider: "claude",
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0.04,
            contextWindowMaxTokens: 200_000,
            contextWindowUsedTokens: 704,
          },
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("starting a new turn clears interrupted compact usage", async () => {
    const session = await createSessionForTurns([
      [
        createSuccessResult({
          total_cost_usd: 0.04,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            iterations: [],
          },
        }),
      ],
    ]);

    try {
      const compactEvents = (session as unknown as TestClaudeSession).translateMessageToEvents(
        createCompactBoundary(),
      );
      expect(compactEvents).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          provider: "claude",
          usage: {
            contextWindowUsedTokens: 704,
          },
        }),
      );

      const events = await collectStreamEvents(session, "next turn");

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn_completed",
          provider: "claude",
          usage: expect.objectContaining({
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0.04,
          }),
        }),
      );
      expect(
        events.some(
          (event) =>
            event.type === "turn_completed" && event.usage.contextWindowUsedTokens !== undefined,
        ),
      ).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("result.result is surfaced as an assistant message when no model output was produced", async () => {
    const session = await createSessionForTest();

    const events = session.translateMessageToEvents({
      type: "result",
      subtype: "success",
      result: "Unknown command: /foo-doesnt-exist",
      is_error: false,
      duration_ms: 2,
      duration_api_ms: 0,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
      permission_denials: [],
      uuid: "result-unknown-1",
      session_id: "session-1",
    } as unknown as SDKMessage);

    expect(events).toContainEqual({
      type: "timeline",
      provider: "claude",
      item: {
        type: "assistant_message",
        text: "Unknown command: /foo-doesnt-exist",
        messageId: "result-unknown-1",
      },
    });
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
  });

  test("result.result is not duplicated when the model produced output during the turn", async () => {
    const session = await createSessionForTest();

    const events = session.translateMessageToEvents({
      type: "result",
      subtype: "success",
      result: "Here is the answer.",
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 80,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 42,
      },
      permission_denials: [],
      uuid: "result-normal-1",
      session_id: "session-1",
    } as unknown as SDKMessage);

    const timelineEvents = events.filter((event) => event.type === "timeline");
    expect(timelineEvents).toEqual([]);
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
  });

  test("result.result is not duplicated when assistant text already streamed with zero token usage", async () => {
    const queryFactory = createQueryFactoryForTurns([
      [
        {
          type: "system",
          subtype: "init",
          session_id: "session-third-party",
          permissionMode: "default",
        },
        {
          type: "assistant",
          message: {
            id: "assistant-third-party-1",
            role: "assistant",
            content: [{ type: "text", text: "Here is the answer." }],
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
          session_id: "session-third-party",
          uuid: "assistant-third-party-event-1",
        },
        {
          type: "result",
          subtype: "success",
          result: "Here is the answer.",
          is_error: false,
          duration_ms: 100,
          duration_api_ms: 80,
          num_turns: 1,
          stop_reason: null,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
          permission_denials: [],
          uuid: "result-third-party-1",
          session_id: "session-third-party",
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

    const result = await session.run("turn");
    await session.close();

    expect(result.timeline).toEqual([
      {
        type: "assistant_message",
        text: "Here is the answer.",
        messageId: "assistant-third-party-1",
      },
    ]);
  });
});

describe("toClaudeSdkMcpConfig", () => {
  test("preserves alwaysLoad on stdio servers", () => {
    expect(
      toClaudeSdkMcpConfig({
        type: "stdio",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
        alwaysLoad: true,
      }),
    ).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
      env: undefined,
      alwaysLoad: true,
    });
  });

  test("preserves alwaysLoad on http servers", () => {
    expect(
      toClaudeSdkMcpConfig({
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
        alwaysLoad: true,
      }),
    ).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
      alwaysLoad: true,
    });
  });

  test("preserves alwaysLoad on sse servers", () => {
    expect(
      toClaudeSdkMcpConfig({
        type: "sse",
        url: "https://example.com/sse",
        alwaysLoad: true,
      }),
    ).toEqual({
      type: "sse",
      url: "https://example.com/sse",
      headers: undefined,
      alwaysLoad: true,
    });
  });

  test("leaves alwaysLoad undefined when not provided (preserves default deferral)", () => {
    const result = toClaudeSdkMcpConfig({
      type: "stdio",
      command: "uvx",
      args: ["markitdown-mcp"],
    });
    expect(result.type).toBe("stdio");
    expect(result.alwaysLoad).toBeUndefined();
  });
});
