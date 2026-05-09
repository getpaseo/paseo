import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentPersistenceHandle, AgentStreamEvent } from "../../agent-sdk-types.js";

const queryFactory = vi.fn();
let lastQuery: ReturnType<typeof buildSdkQueryMock> | null = null;

const LIVE_REPLY_MARKER = "LIVE_ONLY_REPLY_MARKER";
const HISTORY_USER_MARKER = "HISTORY_ONLY_USER_MARKER";
const HISTORY_ASSISTANT_MARKER = "HISTORY_ONLY_ASSISTANT_MARKER";

function sanitizeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/._:]/g, "-");
}

function buildSdkQueryMock() {
  const events = [
    {
      type: "system",
      subtype: "init",
      session_id: "history-session",
      permissionMode: "default",
      model: "opus",
    },
    {
      type: "assistant",
      message: {
        content: LIVE_REPLY_MARKER,
      },
    },
    {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
      total_cost_usd: 0,
    },
  ];

  let index = 0;
  return {
    next: vi.fn(async () => {
      if (index >= events.length) {
        return { done: true, value: undefined };
      }
      const value = events[index];
      index += 1;
      return { done: false, value };
    }),
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

function collectTimelineText(events: AgentStreamEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type !== "timeline") {
      continue;
    }
    if (event.item.type === "user_message") {
      chunks.push(event.item.text);
    }
    if (event.item.type === "assistant_message") {
      chunks.push(event.item.text);
    }
  }
  return chunks.join("\n");
}

describe("ClaudeAgentSession history replay regression", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let previousClaudeConfigDir: string | undefined;

  beforeEach(() => {
    queryFactory.mockImplementation(() => {
      const mock = buildSdkQueryMock();
      lastQuery = mock;
      return mock;
    });

    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-history-regression-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });

    const sanitized = sanitizeClaudeProjectPath(cwd);
    const historyDir = path.join(configDir, "projects", sanitized);
    mkdirSync(historyDir, { recursive: true });
    const historyPath = path.join(historyDir, "history-session.jsonl");
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "history-user-uuid",
          sessionId: "history-session",
          cwd,
          message: {
            role: "user",
            content: HISTORY_USER_MARKER,
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "history-session",
          cwd,
          message: {
            role: "assistant",
            content: HISTORY_ASSISTANT_MARKER,
          },
        }),
      ].join("\n"),
      "utf8",
    );

    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    queryFactory.mockReset();
    lastQuery = null;
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("does not replay persisted history during the first live stream turn", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "history-session",
      nativeHandle: "history-session",
      metadata: {
        provider: "claude",
        cwd,
      },
    };

    const session = await client.resumeSession(handle, { cwd });
    const events: AgentStreamEvent[] = [];

    try {
      for await (const event of streamSession(session, "Say hello")) {
        events.push(event);
        if (
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled"
        ) {
          break;
        }
      }
    } finally {
      await session.close();
    }

    const timelineText = collectTimelineText(events);
    expect(timelineText).toContain(LIVE_REPLY_MARKER);
    expect(timelineText).not.toContain(HISTORY_USER_MARKER);
    expect(timelineText).not.toContain(HISTORY_ASSISTANT_MARKER);
  });

  test("still exposes persisted history through streamHistory", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "history-session",
      nativeHandle: "history-session",
      metadata: {
        provider: "claude",
        cwd,
      },
    };

    const session = await client.resumeSession(handle, { cwd });
    const historyEvents: AgentStreamEvent[] = [];

    try {
      for await (const event of session.streamHistory()) {
        historyEvents.push(event);
      }
    } finally {
      await session.close();
    }

    const timelineText = collectTimelineText(historyEvents);
    expect(timelineText).toContain(HISTORY_USER_MARKER);
    expect(timelineText).toContain(HISTORY_ASSISTANT_MARKER);
  });

  test("listCommands includes rewind command", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "history-session",
      nativeHandle: "history-session",
      metadata: {
        provider: "claude",
        cwd,
      },
    };

    const session = await client.resumeSession(handle, { cwd });
    try {
      const commands = await session.listCommands?.();
      expect(commands?.some((command) => command.name === "rewind")).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("slash /rewind uses latest user message id from persisted history", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "history-session",
      nativeHandle: "history-session",
      metadata: {
        provider: "claude",
        cwd,
      },
    };

    const session = await client.resumeSession(handle, { cwd });
    const events: AgentStreamEvent[] = [];

    try {
      for await (const event of streamSession(session, "/rewind")) {
        events.push(event);
        if (
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled"
        ) {
          break;
        }
      }
    } finally {
      await session.close();
    }

    expect(events.some((event) => event.type === "turn_started")).toBe(true);
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    expect(lastQuery).toBeTruthy();
    expect(lastQuery?.rewindFiles).toHaveBeenCalledTimes(1);
    expect(lastQuery?.rewindFiles).toHaveBeenCalledWith("history-user-uuid", {
      dryRun: false,
    });
  });
});
