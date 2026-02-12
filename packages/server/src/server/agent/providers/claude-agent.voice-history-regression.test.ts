import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./claude-agent.js";
import type {
  AgentPersistenceHandle,
  AgentStreamEvent,
} from "../agent-sdk-types.js";

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdkMocks.query,
}));

const LIVE_REPLY_MARKER = "LIVE_ONLY_REPLY_MARKER";
const HISTORY_USER_MARKER = "HISTORY_ONLY_USER_MARKER";
const HISTORY_ASSISTANT_MARKER = "HISTORY_ONLY_ASSISTANT_MARKER";

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
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
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
    sdkMocks.query.mockImplementation(() => buildSdkQueryMock());

    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-history-regression-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });

    const sanitized = cwd.replace(/[\\/\.]/g, "-").replace(/_/g, "-");
    const historyDir = path.join(configDir, "projects", sanitized);
    mkdirSync(historyDir, { recursive: true });
    const historyPath = path.join(historyDir, "history-session.jsonl");
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          type: "user",
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
      "utf8"
    );

    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    sdkMocks.query.mockReset();
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("does not replay persisted history during the first live stream turn", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({ logger });
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
      for await (const event of session.stream("Say hello")) {
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
    const client = new ClaudeAgentClient({ logger });
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
});
