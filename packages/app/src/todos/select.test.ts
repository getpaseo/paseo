import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { selectLatestAgentTodos } from "./select";

function todoList(id: string, items: Array<{ text: string; completed: boolean }>): StreamItem {
  return {
    kind: "todo_list",
    id,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    provider: "claude",
    items,
  };
}

describe("selectLatestAgentTodos", () => {
  it("returns null for empty streams", () => {
    expect(selectLatestAgentTodos(undefined)).toBeNull();
    expect(selectLatestAgentTodos([])).toBeNull();
  });

  it("returns the latest non-empty todo list", () => {
    const stream: StreamItem[] = [
      todoList("t1", [{ text: "old", completed: true }]),
      {
        kind: "user_message",
        id: "u1",
        text: "working",
        timestamp: new Date("2026-01-01T00:00:01.000Z"),
      },
      todoList("t2", [
        { text: "first", completed: true },
        { text: "second", completed: false },
      ]),
    ];

    expect(selectLatestAgentTodos(stream)).toEqual({
      items: [
        { text: "first", completed: true },
        { text: "second", completed: false },
      ],
      completedCount: 1,
      totalCount: 2,
    });
  });

  it("treats an empty latest todo list as cleared", () => {
    const stream: StreamItem[] = [
      todoList("t1", [{ text: "keep", completed: false }]),
      todoList("t2", []),
    ];
    expect(selectLatestAgentTodos(stream)).toBeNull();
  });
});
