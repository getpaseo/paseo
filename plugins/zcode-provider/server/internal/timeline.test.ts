import { describe, expect, test } from "vitest";
import { mapEventToTimelineItems } from "./timeline.js";

describe("ZCode timeline mapping", () => {
  test("maps an assistant message", () => {
    const items = mapEventToTimelineItems({
      type: "message.upserted",
      sessionId: "s1",
      seq: 1,
      payload: { content: "hello" },
    });
    expect(items).toEqual([{ id: "s1-1", type: "assistant_message", text: "hello" }]);
  });

  test("maps a reasoning delta", () => {
    const items = mapEventToTimelineItems({
      type: "part.delta",
      sessionId: "s1",
      seq: 2,
      payload: { messageId: "m2", partId: "p2", field: "reasoning", delta: "thinking" },
    });
    expect(items[0]).toMatchObject({ type: "reasoning", text: "thinking" });
  });

  test("maps a scheduled tool call", () => {
    const items = mapEventToTimelineItems({
      type: "tool.updated",
      sessionId: "s1",
      seq: 3,
      payload: {
        toolCallId: "t1",
        toolName: "read_file",
        kind: "scheduled",
        input: { path: "/a" },
      },
    });
    expect(items[0]).toMatchObject({
      type: "tool_call",
      callId: "t1",
      name: "read_file",
      status: "running",
      error: null,
      detail: { type: "read", filePath: "/a" },
    });
  });

  test("maps a completed tool call and keeps the detail from the scheduled event", () => {
    const toolDetails = new Map([["t1", { type: "read", filePath: "/a" } as const]]);
    const items = mapEventToTimelineItems(
      {
        type: "tool.updated",
        sessionId: "s1",
        seq: 4,
        payload: { toolCallId: "t1", toolName: "read_file", kind: "result" },
      },
      { toolDetails },
    );
    expect(items[0]).toMatchObject({
      type: "tool_call",
      callId: "t1",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: "/a" },
    });
  });

  test("maps a failed tool call", () => {
    const items = mapEventToTimelineItems({
      type: "tool.updated",
      sessionId: "s1",
      seq: 5,
      payload: {
        toolCallId: "t2",
        toolName: "bash",
        kind: "error",
        error: { message: "boom" },
      },
    });
    expect(items[0]).toMatchObject({
      type: "tool_call",
      callId: "t2",
      status: "failed",
      error: { message: "boom" },
    });
  });

  test("returns nothing for an event it does not map", () => {
    expect(
      mapEventToTimelineItems({
        type: "session.updated",
        sessionId: "s1",
        seq: 4,
        payload: {},
      }),
    ).toEqual([]);
  });
});
