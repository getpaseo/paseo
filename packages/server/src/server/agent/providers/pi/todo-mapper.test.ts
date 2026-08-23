import { describe, expect, test } from "vitest";

import { parseToolResult } from "./tool-call-mapper.js";
import { mapPiTodoMessages, mapPiTodoToolResult } from "./todo-mapper.js";

describe("Pi todo mapper", () => {
  test("maps todo extension tool results", () => {
    expect(
      mapPiTodoToolResult(
        parseToolResult({
          content: [{ type: "text", text: "Added todo #2" }],
          details: {
            action: "add",
            todos: [
              { id: 1, text: "alpha task", done: true },
              { id: 2, text: "beta task", done: false },
            ],
            nextId: 3,
          },
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", status: "completed", completed: true },
        { text: "beta task", status: "pending", completed: false },
      ],
    });
  });

  test("hydrates todos from the most recent todo tool result in message history", () => {
    expect(
      mapPiTodoMessages([
        {
          role: "toolResult",
          toolCallId: "1",
          toolName: "todo",
          content: [],
          details: { todos: [{ id: 1, text: "stale", done: false }], nextId: 2 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "working..." }],
        },
        {
          role: "toolResult",
          toolCallId: "2",
          toolName: "todo",
          content: [],
          details: {
            todos: [
              { id: 1, text: "stale", done: true },
              { id: 2, text: "fresh", done: false },
            ],
            nextId: 3,
          },
        },
      ]),
    ).toEqual({
      type: "todo",
      items: [
        { text: "stale", status: "completed", completed: true },
        { text: "fresh", status: "pending", completed: false },
      ],
    });
  });

  test("drops malformed or absent todo inputs", () => {
    expect(
      mapPiTodoToolResult(parseToolResult({ content: [], details: { todos: [{ id: 1 }] } })),
    ).toBeNull();
    expect(
      mapPiTodoToolResult(parseToolResult({ content: [], details: { phases: [] } })),
    ).toBeNull();
    expect(mapPiTodoToolResult(parseToolResult("no todos"))).toBeNull();
    expect(
      mapPiTodoMessages([
        {
          role: "toolResult",
          toolCallId: "1",
          toolName: "write",
          content: [],
          details: { todos: [{ id: 1, text: "wrong tool", done: false }] },
        },
      ]),
    ).toBeNull();
  });
});
