import { describe, expect, test } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

import {
  GROK_SESSION_UPDATE_METHOD,
  buildGrokBackgroundTaskCallId,
  isGrokHiddenFromScrollbackUserChunk,
  mapGrokExtensionNotificationToTimelineItems,
} from "./grok-background-tasks.js";

function userChunk(
  text: string,
  options: { messageId?: string | null; hideFromScrollback?: boolean } = {},
): Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }> {
  let meta: { hideFromScrollback: boolean; modelId?: string } | undefined;
  if (options.hideFromScrollback === true) {
    meta = { hideFromScrollback: true, modelId: "grok-4.5" };
  } else if (options.hideFromScrollback === false) {
    meta = { hideFromScrollback: false };
  }

  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
    ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

function taskParams(input: {
  sessionId?: string;
  sessionUpdate: "task_backgrounded" | "task_completed";
  taskId?: string;
  command?: string;
  cwd?: string;
  output?: string | null;
  truncated?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  kind?: string;
}): Record<string, unknown> {
  return {
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    update: {
      sessionUpdate: input.sessionUpdate,
      task_snapshot: {
        task_id: input.taskId ?? "task-1",
        command: input.command ?? "sleep 1",
        cwd: input.cwd ?? "/tmp",
        output: input.output === undefined ? "done" : input.output,
        truncated: input.truncated ?? false,
        exit_code: input.exitCode === undefined ? 0 : input.exitCode,
        signal: input.signal === undefined ? null : input.signal,
        completed: input.sessionUpdate === "task_completed",
        kind: input.kind ?? "bash",
      },
      will_wake: true,
    },
  };
}

describe("isGrokHiddenFromScrollbackUserChunk", () => {
  test("suppresses only when hideFromScrollback is strictly true", () => {
    expect(
      isGrokHiddenFromScrollbackUserChunk(
        userChunk("<system-reminder>Background task completed</system-reminder>", {
          hideFromScrollback: true,
        }),
      ),
    ).toBe(true);
    expect(
      isGrokHiddenFromScrollbackUserChunk(
        userChunk("hello", { hideFromScrollback: false, messageId: "msg-1" }),
      ),
    ).toBe(false);
    expect(isGrokHiddenFromScrollbackUserChunk(userChunk("hello", { messageId: "msg-1" }))).toBe(
      false,
    );
  });

  test("does not use system-reminder text as a global filter signal", () => {
    expect(
      isGrokHiddenFromScrollbackUserChunk(
        userChunk("<system-reminder>not a real hidden chunk</system-reminder>"),
      ),
    ).toBe(false);
  });
});

describe("mapGrokExtensionNotificationToTimelineItems", () => {
  test("returns null for unrelated extension methods", () => {
    expect(
      mapGrokExtensionNotificationToTimelineItems(
        "_other.vendor/update",
        taskParams({ sessionUpdate: "task_completed" }),
        { sessionId: "session-1" },
      ),
    ).toBeNull();
  });

  test("ignores wrong-session notifications without throwing", () => {
    expect(
      mapGrokExtensionNotificationToTimelineItems(
        GROK_SESSION_UPDATE_METHOD,
        taskParams({ sessionId: "other", sessionUpdate: "task_completed" }),
        { sessionId: "session-1" },
      ),
    ).toEqual([]);
  });

  test("ignores malformed payloads without throwing", () => {
    expect(
      mapGrokExtensionNotificationToTimelineItems(
        GROK_SESSION_UPDATE_METHOD,
        { sessionId: "session-1", update: { sessionUpdate: "task_completed" } },
        { sessionId: "session-1" },
      ),
    ).toEqual([]);
    expect(
      mapGrokExtensionNotificationToTimelineItems(
        GROK_SESSION_UPDATE_METHOD,
        { sessionId: "session-1", update: "not-an-object" },
        { sessionId: "session-1" },
      ),
    ).toEqual([]);
  });

  test("maps task_backgrounded to a running synthetic tool_call", () => {
    const items = mapGrokExtensionNotificationToTimelineItems(
      GROK_SESSION_UPDATE_METHOD,
      taskParams({
        sessionId: "session-1",
        sessionUpdate: "task_backgrounded",
        taskId: "abc-123",
        command: "npm test",
      }),
      { sessionId: "session-1" },
    );

    expect(items).toEqual([
      expect.objectContaining({
        type: "tool_call",
        callId: buildGrokBackgroundTaskCallId("abc-123"),
        name: "background_task",
        status: "running",
        error: null,
        detail: expect.objectContaining({
          type: "plain_text",
          icon: "wrench",
          label: "Background: npm test",
        }),
        metadata: expect.objectContaining({
          synthetic: true,
          source: "grok_background_task",
          taskId: "abc-123",
          sessionUpdate: "task_backgrounded",
        }),
      }),
    ]);
  });

  test("maps successful task_completed to completed status", () => {
    const items = mapGrokExtensionNotificationToTimelineItems(
      GROK_SESSION_UPDATE_METHOD,
      taskParams({
        sessionId: "session-1",
        sessionUpdate: "task_completed",
        taskId: "abc-123",
        exitCode: 0,
        output: "ok",
      }),
      { sessionId: "session-1" },
    );

    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      type: "tool_call",
      callId: buildGrokBackgroundTaskCallId("abc-123"),
      status: "completed",
      error: null,
    });
  });

  test("maps non-zero exit to failed", () => {
    const items = mapGrokExtensionNotificationToTimelineItems(
      GROK_SESSION_UPDATE_METHOD,
      taskParams({
        sessionId: "session-1",
        sessionUpdate: "task_completed",
        taskId: "fail-1",
        exitCode: 2,
        output: "boom",
      }),
      { sessionId: "session-1" },
    );

    expect(items?.[0]).toMatchObject({
      status: "failed",
      error: { message: "Background task exited with code 2" },
    });
  });

  test("maps signal/cancellation to canceled", () => {
    const items = mapGrokExtensionNotificationToTimelineItems(
      GROK_SESSION_UPDATE_METHOD,
      taskParams({
        sessionId: "session-1",
        sessionUpdate: "task_completed",
        taskId: "sig-1",
        exitCode: null,
        signal: "SIGTERM",
        output: null,
      }),
      { sessionId: "session-1" },
    );

    expect(items?.[0]).toMatchObject({
      status: "canceled",
      error: null,
      detail: expect.objectContaining({
        text: expect.stringContaining("Signal: SIGTERM"),
      }),
    });
  });

  test("handles missing output and truncated output", () => {
    const missing = mapGrokExtensionNotificationToTimelineItems(
      GROK_SESSION_UPDATE_METHOD,
      taskParams({
        sessionId: "session-1",
        sessionUpdate: "task_completed",
        taskId: "out-1",
        output: null,
      }),
      { sessionId: "session-1" },
    );
    expect(missing?.[0]).toMatchObject({
      status: "completed",
      detail: expect.objectContaining({
        text: expect.stringContaining("(no output)"),
      }),
    });

    const truncated = mapGrokExtensionNotificationToTimelineItems(
      GROK_SESSION_UPDATE_METHOD,
      taskParams({
        sessionId: "session-1",
        sessionUpdate: "task_completed",
        taskId: "out-2",
        output: "partial",
        truncated: true,
      }),
      { sessionId: "session-1" },
    );
    expect(truncated?.[0]).toMatchObject({
      detail: expect.objectContaining({
        text: expect.stringContaining("Output truncated"),
      }),
      metadata: expect.objectContaining({ truncated: true }),
    });
  });

  test("uses a stable callId from task_id for lifecycle projection", () => {
    const backgrounded = mapGrokExtensionNotificationToTimelineItems(
      GROK_SESSION_UPDATE_METHOD,
      taskParams({
        sessionId: "session-1",
        sessionUpdate: "task_backgrounded",
        taskId: "stable-id",
      }),
      { sessionId: "session-1" },
    );
    const completed = mapGrokExtensionNotificationToTimelineItems(
      GROK_SESSION_UPDATE_METHOD,
      taskParams({
        sessionId: "session-1",
        sessionUpdate: "task_completed",
        taskId: "stable-id",
      }),
      { sessionId: "session-1" },
    );

    expect(backgrounded?.[0]).toMatchObject({
      callId: buildGrokBackgroundTaskCallId("stable-id"),
      status: "running",
    });
    expect(completed?.[0]).toMatchObject({
      callId: buildGrokBackgroundTaskCallId("stable-id"),
      status: "completed",
    });
  });

  test("callIds for task IDs that only differ by normalized characters do not collide", () => {
    expect(buildGrokBackgroundTaskCallId("task/1")).not.toBe(
      buildGrokBackgroundTaskCallId("task_1"),
    );
    expect(buildGrokBackgroundTaskCallId("task/1")).toBe(buildGrokBackgroundTaskCallId("task/1"));
  });
});
