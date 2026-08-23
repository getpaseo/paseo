import { describe, expect, test } from "vitest";

import { parseToolResult } from "./tool-call-mapper.js";
import { mapPiTodoMessages, mapPiTodoToolResult } from "./todo-mapper.js";

describe("Pi todo mapper", () => {
  test("maps rpiv-todo tool results, preserving in_progress and dropping tombstones", () => {
    expect(
      mapPiTodoToolResult(
        parseToolResult({
          content: [{ type: "text", text: "Created #2" }],
          details: {
            action: "create",
            params: {},
            tasks: [
              { id: 1, subject: "alpha task", status: "completed", owner: "agent" },
              { id: 2, subject: "beta task", status: "in_progress" },
              { id: 3, subject: "gamma task", status: "pending" },
              { id: 4, subject: "deleted task", status: "deleted" },
            ],
            nextId: 5,
          },
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", status: "completed", completed: true },
        { text: "beta task", status: "in_progress", completed: false },
        { text: "gamma task", status: "pending", completed: false },
      ],
    });
  });

  test("maps the example todo.ts tool results", () => {
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
            tasks: [
              { id: 1, subject: "stale", status: "completed" },
              { id: 2, subject: "fresh", status: "pending" },
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
      mapPiTodoToolResult(
        parseToolResult({ content: [], details: { tasks: [{ subject: "x", status: "bogus" }] } }),
      ),
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
