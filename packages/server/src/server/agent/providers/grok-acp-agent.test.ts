import { expect, test } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";
import { ACPAgentSession } from "./acp-agent.js";
import {
  GROK_SESSION_UPDATE_METHOD,
  buildGrokBackgroundTaskCallId,
  isGrokHiddenFromScrollbackUserChunk,
  mapGrokExtensionNotificationToTimelineItems,
} from "./grok-background-tasks.js";

const GROK_ACP_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
} as const;

function createGrokBackgroundTaskSession(): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "grok",
      cwd: "/tmp/paseo-grok-bg-test",
    },
    {
      provider: "grok",
      logger: createTestLogger(),
      defaultCommand: ["grok", "agent", "stdio"],
      defaultModes: [],
      capabilities: GROK_ACP_CAPABILITIES,
      shouldSuppressUserMessageChunk: isGrokHiddenFromScrollbackUserChunk,
      extensionNotificationHandler: mapGrokExtensionNotificationToTimelineItems,
    },
  );
}

function createGenericAcpSession(): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "claude-acp",
      cwd: "/tmp/paseo-generic-acp-test",
    },
    {
      provider: "claude-acp",
      logger: createTestLogger(),
      defaultCommand: ["claude", "--acp"],
      defaultModes: [],
      capabilities: GROK_ACP_CAPABILITIES,
    },
  );
}

function collectTimelineItems(session: ACPAgentSession): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  session.subscribe((event: AgentStreamEvent) => {
    if (event.type === "timeline") {
      items.push(event.item);
    }
  });
  return items;
}

async function flushPendingUserMessages(
  session: ACPAgentSession,
  sessionId = "session-1",
): Promise<void> {
  await session.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
    },
  });
}

function hiddenUserChunk(
  text: string,
  messageId?: string | null,
): Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }> {
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
    ...(messageId !== undefined ? { messageId } : {}),
    _meta: { hideFromScrollback: true, modelId: "grok-4.5" },
  };
}

test("live Grok session suppresses hideFromScrollback user chunks", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk(
      '<system-reminder>Background task "task-1" completed (exit code: 0).</system-reminder>',
      "msg-hidden",
    ),
  });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "real user prompt" },
      messageId: "msg-visible",
    },
  });
  expect(items).toEqual([]);
  await flushPendingUserMessages(session);

  expect(items).toEqual([
    { type: "user_message", text: "real user prompt", messageId: "msg-visible" },
  ]);
  expect(items.every((item) => !("text" in item && item.text.includes("system-reminder")))).toBe(
    true,
  );
});

test("history replay also suppresses hideFromScrollback user chunks", async () => {
  const session = createGrokBackgroundTaskSession();
  const internals = asInternals<{
    sessionId: string | null;
    replayingHistory: boolean;
    persistedHistory: AgentTimelineItem[];
  }>(session);
  internals.sessionId = "session-1";
  internals.replayingHistory = true;

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk("<system-reminder>Background task completed</system-reminder>"),
  });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "visible during load" },
      messageId: "msg-load",
    },
  });
  expect(internals.persistedHistory).toEqual([]);
  await flushPendingUserMessages(session);

  expect(internals.persistedHistory).toEqual([
    { type: "user_message", text: "visible during load", messageId: "msg-load" },
  ]);
});

test("hidden chunk without messageId does not contaminate a later visible user message", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk("<system-reminder>hidden wake-up without messageId</system-reminder>"),
  });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "first visible" },
    },
  });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: " second" },
    },
  });
  expect(items).toEqual([]);
  await flushPendingUserMessages(session);

  expect(items.map((item) => ("text" in item ? item.text : null))).toEqual([
    "first visible second",
  ]);
});

test("generic ACP provider still renders hideFromScrollback chunks as user messages", async () => {
  const session = createGenericAcpSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk("<system-reminder>would be hidden only for Grok</system-reminder>"),
  });
  expect(items).toEqual([]);
  await flushPendingUserMessages(session);

  expect(items).toEqual([
    {
      type: "user_message",
      text: "<system-reminder>would be hidden only for Grok</system-reminder>",
    },
  ]);
});

test("Grok hidden-only user chunks stay off the timeline after flush", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.sessionUpdate({
    sessionId: "session-1",
    update: hiddenUserChunk("<system-reminder>only hidden</system-reminder>", "msg-only-hidden"),
  });
  await flushPendingUserMessages(session);

  expect(items).toEqual([]);
});

test("Grok task_backgrounded then task_completed project one synthetic tool lifecycle", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";
  const callId = buildGrokBackgroundTaskCallId("task-lifecycle");

  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_backgrounded",
      task_snapshot: {
        task_id: "task-lifecycle",
        command: "npm test",
        cwd: "/tmp",
        output: null,
        truncated: false,
        exit_code: null,
        signal: null,
        completed: false,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "task-lifecycle",
        command: "npm test",
        cwd: "/tmp",
        output: "ok",
        truncated: false,
        exit_code: 0,
        signal: null,
        completed: true,
        kind: "bash",
      },
      will_wake: true,
    },
  });

  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ type: "tool_call", callId, status: "running" });
  expect(items[1]).toMatchObject({ type: "tool_call", callId, status: "completed", error: null });
});

test("Grok failed, canceled, missing-output, and truncated task states", async () => {
  const session = createGrokBackgroundTaskSession();
  const items = collectTimelineItems(session);
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";

  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "fail",
        command: "false",
        exit_code: 1,
        signal: null,
        output: "err",
        truncated: false,
        completed: true,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "cancel",
        command: "sleep 99",
        exit_code: null,
        signal: "SIGINT",
        output: null,
        truncated: false,
        completed: true,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "no-out",
        command: "true",
        exit_code: 0,
        signal: null,
        output: null,
        truncated: false,
        completed: true,
        kind: "bash",
      },
    },
  });
  await session.extNotification(GROK_SESSION_UPDATE_METHOD, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "trunc",
        command: "yes",
        exit_code: 0,
        signal: null,
        output: "partial",
        truncated: true,
        completed: true,
        kind: "bash",
      },
    },
  });

  expect(items).toHaveLength(4);
  expect(items[0]).toMatchObject({
    callId: buildGrokBackgroundTaskCallId("fail"),
    status: "failed",
  });
  expect(items[1]).toMatchObject({
    callId: buildGrokBackgroundTaskCallId("cancel"),
    status: "canceled",
  });
  expect(items[2]).toMatchObject({
    callId: buildGrokBackgroundTaskCallId("no-out"),
    status: "completed",
    detail: expect.objectContaining({ text: expect.stringContaining("(no output)") }),
  });
  expect(items[3]).toMatchObject({
    callId: buildGrokBackgroundTaskCallId("trunc"),
    status: "completed",
    metadata: expect.objectContaining({ truncated: true }),
  });
});
