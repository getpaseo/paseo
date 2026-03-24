import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./claude-agent.js";
import type { AgentPersistenceHandle, AgentStreamEvent } from "../agent-sdk-types.js";

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
  lastQuery: null as ReturnType<typeof buildSdkQueryMock> | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdkMocks.query,
}));

const LIVE_REPLY_MARKER = "LIVE_ONLY_REPLY_MARKER";
const HISTORY_USER_MARKER = "HISTORY_ONLY_USER_MARKER";
const HISTORY_ASSISTANT_MARKER = "HISTORY_ONLY_ASSISTANT_MARKER";
const APPENDED_TASK_NOTIFICATION_MARKER = "Appended background task completed";
const APPENDED_ASSISTANT_MARKER = "APPENDED_BACKGROUND_ASSISTANT_MARKER";

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

function buildIdleSdkQueryMock() {
  return {
    next: vi.fn(async () => ({ done: true, value: undefined })),
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

async function readNextEvent(
  iterator: AsyncIterator<AgentStreamEvent>,
  timeoutMs: number,
): Promise<AgentStreamEvent> {
  const outcome = await Promise.race([
    iterator.next().then((result) => ({ kind: "result" as const, result })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);

  if (outcome.kind === "timeout") {
    throw new Error("Timed out waiting for live event");
  }

  if (outcome.result.done) {
    throw new Error("Live event stream ended before appended transcript arrived");
  }

  return outcome.result.value;
}

describe("ClaudeAgentSession history replay regression", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let previousClaudeConfigDir: string | undefined;

  beforeEach(() => {
    sdkMocks.query.mockImplementation(() => {
      const mock = buildSdkQueryMock();
      sdkMocks.lastQuery = mock;
      return mock;
    });

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
    sdkMocks.query.mockReset();
    sdkMocks.lastQuery = null;
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

  test("emits appended transcript lines through streamLiveEvents after history was primed", async () => {
    sdkMocks.query.mockImplementation(() => {
      const mock = buildIdleSdkQueryMock();
      sdkMocks.lastQuery = mock;
      return mock;
    });

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

    const sanitized = cwd.replace(/[\\/\.]/g, "-").replace(/_/g, "-");
    const historyPath = path.join(configDir, "projects", sanitized, "history-session.jsonl");

    const session = await client.resumeSession(handle, { cwd });

    try {
      for await (const _event of session.streamHistory()) {
        // Prime existing persisted history the same way agent-manager does.
      }

      const liveEvents = session.streamLiveEvents();
      const iterator = liveEvents[Symbol.asyncIterator]();

      appendFileSync(
        historyPath,
        `\n${JSON.stringify({
          type: "queue-operation",
          operation: "enqueue",
          uuid: "appended-task-note-1",
          content: [
            "<task-notification>",
            "<task-id>appended-bg-1</task-id>",
            "<status>completed</status>",
            `<summary>${APPENDED_TASK_NOTIFICATION_MARKER}</summary>`,
            "<output-file>/tmp/appended-bg-1.txt</output-file>",
            "</task-notification>",
          ].join("\n"),
        })}\n${JSON.stringify({
          type: "assistant",
          sessionId: "history-session",
          cwd,
          message: {
            role: "assistant",
            content: APPENDED_ASSISTANT_MARKER,
          },
        })}`,
        "utf8",
      );

      const appendedEvents: AgentStreamEvent[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        appendedEvents.push(await readNextEvent(iterator, 1_500));
        const sawTaskNotification = appendedEvents.some(
          (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.name === "task_notification",
        );
        const sawAssistant = appendedEvents.some(
          (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
            event.type === "timeline" &&
            event.item.type === "assistant_message" &&
            event.item.text.includes(APPENDED_ASSISTANT_MARKER),
        );
        if (sawTaskNotification && sawAssistant) {
          break;
        }
      }
      const timelineText = collectTimelineText(appendedEvents);
      const taskNotificationEvent = appendedEvents.find(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.name === "task_notification",
      );
      const turnStartedEvent = appendedEvents.find(
        (event): event is Extract<AgentStreamEvent, { type: "turn_started" }> =>
          event.type === "turn_started",
      );

      expect(taskNotificationEvent).toBeTruthy();
      expect(turnStartedEvent).toBeTruthy();
      expect(timelineText).toContain(APPENDED_ASSISTANT_MARKER);
      expect(taskNotificationEvent?.item.metadata).toMatchObject({
        taskId: "appended-bg-1",
        status: "completed",
        outputFile: "/tmp/appended-bg-1.txt",
      });
      expect(taskNotificationEvent?.item.detail).toMatchObject({
        type: "plain_text",
        label: APPENDED_TASK_NOTIFICATION_MARKER,
      });
    } finally {
      await session.close();
    }
  });

  test("listCommands includes rewind command", async () => {
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
    try {
      const commands = await session.listCommands?.();
      expect(commands?.some((command) => command.name === "rewind")).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("slash /rewind uses latest user message id from persisted history", async () => {
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
      for await (const event of session.stream("/rewind")) {
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
    expect(sdkMocks.lastQuery).toBeTruthy();
    expect(sdkMocks.lastQuery?.rewindFiles).toHaveBeenCalledTimes(1);
    expect(sdkMocks.lastQuery?.rewindFiles).toHaveBeenCalledWith("history-user-uuid", {
      dryRun: false,
    });
  });
});
