import { describe, expect, it } from "vitest";

import {
  isTaskNotificationUserContent,
  mapTaskNotificationSystemRecordToToolCall,
  mapTaskNotificationUserContentToToolCall,
} from "./task-notification-tool-call.js";

describe("task-notification-tool-call", () => {
  it("detects task notification user content in string payloads", () => {
    expect(
      isTaskNotificationUserContent(
        "<task-notification>\n<task-id>bg-1</task-id>\n</task-notification>"
      )
    ).toBe(true);
    expect(isTaskNotificationUserContent("hello")).toBe(false);
  });

  it("maps user content to completed synthetic tool call", () => {
    const content =
      "<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n</task-notification>";
    const item = mapTaskNotificationUserContentToToolCall({
      content,
      messageId: "task-note-user-1",
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "task_notification_task-note-user-1",
      name: "task_notification",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        label: "Background task completed",
        icon: "wrench",
        text: content,
      },
      metadata: {
        synthetic: true,
        source: "claude_task_notification",
        taskId: "bg-1",
        status: "completed",
      },
    });
  });

  it("maps system task notification to failed synthetic tool call", () => {
    const item = mapTaskNotificationSystemRecordToToolCall({
      record: {
        subtype: "task_notification",
        uuid: "task-note-system-1",
        task_id: "bg-fail-1",
        status: "failed",
        summary: "Background task failed",
        output_file: "/tmp/bg-fail-1.txt",
      },
    });

    expect(item).toEqual({
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
    });
  });

  it("returns null for non-task system records", () => {
    const item = mapTaskNotificationSystemRecordToToolCall({
      record: {
        subtype: "init",
      },
    });

    expect(item).toBeNull();
  });
});
