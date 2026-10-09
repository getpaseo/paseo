import { describe, expect, it } from "vitest";
import { transformPiTodoToolCall } from "./client/transform-pi-tasks";

function completedTodo(output: unknown) {
  return {
    type: "tool_call" as const,
    callId: "todo-1",
    name: "todo",
    status: "completed" as const,
    error: null,
    detail: { type: "unknown" as const, input: {}, output },
  };
}

describe("Pi task timeline example", () => {
  it("maps @juicesharp/rpiv-todo and drops deleted tasks", () => {
    const result = transformPiTodoToolCall({
      phase: "complete",
      item: completedTodo({
        content: [{ type: "text", text: "Created #2" }],
        details: {
          tasks: [
            { id: 1, subject: "alpha task", status: "completed", owner: "agent" },
            { id: 2, subject: "beta task", status: "in_progress" },
            { id: 3, subject: "gamma task", status: "pending" },
            { id: 4, subject: "deleted task", status: "deleted" },
          ],
        },
      }),
    });

    expect(result).toEqual({
      items: [
        {
          type: "plugin",
          kind: "pi-task-list",
          version: 1,
          data: {
            tasks: [
              { text: "alpha task", status: "completed" },
              { text: "beta task", status: "in_progress" },
              { text: "gamma task", status: "pending" },
            ],
          },
        },
      ],
    });
  });

  it("maps Pi's example todo extension", () => {
    const result = transformPiTodoToolCall({
      phase: "complete",
      item: completedTodo({
        details: {
          todos: [
            { id: 1, text: "alpha task", done: true },
            { id: 2, text: "beta task", done: false },
          ],
        },
      }),
    });

    expect(result?.items[0]?.data).toEqual({
      tasks: [
        { text: "alpha task", status: "completed" },
        { text: "beta task", status: "pending" },
      ],
    });
  });

  it("keeps unrelated and malformed tool calls unchanged", () => {
    expect(
      transformPiTodoToolCall({
        phase: "complete",
        item: { ...completedTodo({ details: { todos: [] } }), name: "write" },
      }),
    ).toBeUndefined();
    expect(
      transformPiTodoToolCall({
        phase: "complete",
        item: completedTodo({ details: { phases: [] } }),
      }),
    ).toBeUndefined();
  });

  it("maps a running todo tool call", () => {
    const result = transformPiTodoToolCall({
      phase: "streaming",
      item: {
        ...completedTodo({ details: { todos: [{ text: "live task", done: false }] } }),
        status: "running",
      },
    });

    expect(result?.items[0]?.data).toEqual({
      tasks: [{ text: "live task", status: "pending" }],
    });
  });
});
