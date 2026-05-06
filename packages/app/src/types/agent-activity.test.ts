import { describe, expect, it } from "vitest";
import { groupActivities, type AgentActivity } from "./agent-activity";

function timestamp(seconds: number): Date {
  return new Date(`2026-01-01T00:00:${seconds.toString().padStart(2, "0")}.000Z`);
}

describe("groupActivities", () => {
  it("groups text chunks and merges tool call updates at the first tool position", () => {
    const activities: AgentActivity[] = [
      {
        timestamp: timestamp(1),
        update: {
          kind: "agent_message_chunk",
          content: { type: "text", text: "Hel" },
        },
      },
      {
        timestamp: timestamp(2),
        update: {
          kind: "agent_message_chunk",
          content: { type: "text", text: "lo" },
        },
      },
      {
        timestamp: timestamp(3),
        update: {
          kind: "tool_call",
          toolCallId: "tool_1",
          title: "Read file",
          status: "in_progress",
          toolKind: "read",
          input: { path: "README.md" },
        },
      },
      {
        timestamp: timestamp(4),
        update: {
          kind: "agent_thought_chunk",
          content: { type: "text", text: "Checking context" },
        },
      },
      {
        timestamp: timestamp(5),
        update: {
          kind: "tool_call_update",
          toolCallId: "tool_1",
          status: "completed",
          output: { ok: true },
        },
      },
    ];

    expect(groupActivities(activities)).toEqual([
      {
        kind: "grouped_text",
        messageType: "agent",
        text: "Hello",
        startTimestamp: timestamp(1),
        endTimestamp: timestamp(2),
      },
      {
        kind: "merged_tool_call",
        toolCallId: "tool_1",
        title: "Read file",
        status: "completed",
        toolKind: "read",
        input: { path: "README.md" },
        output: { ok: true },
        content: undefined,
        locations: undefined,
        startTimestamp: timestamp(3),
        endTimestamp: timestamp(5),
      },
      {
        kind: "grouped_text",
        messageType: "thought",
        text: "Checking context",
        startTimestamp: timestamp(4),
        endTimestamp: timestamp(4),
      },
    ]);
  });

  it("creates a merged tool call when an update arrives before the initial call", () => {
    const activities: AgentActivity[] = [
      {
        timestamp: timestamp(1),
        update: {
          kind: "tool_call_update",
          toolCallId: "tool_2",
          title: "Shell",
          status: "completed",
          toolKind: "execute",
          output: { exitCode: 0 },
        },
      },
    ];

    expect(groupActivities(activities)).toEqual([
      {
        kind: "merged_tool_call",
        toolCallId: "tool_2",
        title: "Shell",
        status: "completed",
        toolKind: "execute",
        input: undefined,
        output: { exitCode: 0 },
        content: undefined,
        locations: undefined,
        startTimestamp: timestamp(1),
        endTimestamp: timestamp(1),
      },
    ]);
  });
});
