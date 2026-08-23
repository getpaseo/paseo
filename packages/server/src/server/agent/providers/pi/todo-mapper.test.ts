import { describe, expect, test } from "vitest";

import { parseToolResult } from "./tool-call-mapper.js";
import { mapPiTodoReminderEvent, mapPiTodoState, mapPiTodoToolResult } from "./todo-mapper.js";

const TODO_PHASES = [
  {
    name: "Tasks",
    tasks: [
      { content: "alpha task", status: "completed" },
      { content: "beta task", status: "in_progress" },
      { content: "gamma task", status: "pending" },
    ],
  },
] as const;

describe("Pi todo mapper", () => {
  test("maps todo tool results without losing progress status", () => {
    expect(
      mapPiTodoToolResult(
        parseToolResult({
          content: [],
          details: {
            phases: [
              {
                name: "Tasks",
                tasks: [
                  { content: "alpha task", status: "in_progress" },
                  { content: "beta task", status: "pending" },
                  { content: "gamma task", status: "pending" },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", status: "in_progress", completed: false },
        { text: "beta task", status: "pending", completed: false },
        { text: "gamma task", status: "pending", completed: false },
      ],
    });

    expect(
      mapPiTodoToolResult(parseToolResult({ content: [], details: { phases: TODO_PHASES } })),
    ).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", status: "completed", completed: true },
        { text: "beta task", status: "in_progress", completed: false },
        { text: "gamma task", status: "pending", completed: false },
      ],
    });
  });

  test("maps todo reminder events", () => {
    expect(
      mapPiTodoReminderEvent({
        type: "todo_reminder",
        todos: [
          { content: "beta task", status: "in_progress" },
          { content: "gamma task", status: "pending" },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        { text: "beta task", status: "in_progress", completed: false },
        { text: "gamma task", status: "pending", completed: false },
      ],
    });
  });

  test("hydrates current todos from session state", () => {
    expect(
      mapPiTodoState({
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        sessionId: "session",
        messageCount: 0,
        pendingMessageCount: 0,
        todoPhases: TODO_PHASES,
      }),
    ).toEqual([
      {
        type: "todo",
        items: [
          { text: "alpha task", status: "completed", completed: true },
          { text: "beta task", status: "in_progress", completed: false },
          { text: "gamma task", status: "pending", completed: false },
        ],
      },
    ]);
  });

  test("drops malformed todo inputs", () => {
    expect(mapPiTodoReminderEvent({ type: "todo_reminder", todos: [{ content: 1 }] })).toBeNull();
    expect(mapPiTodoToolResult({ details: { phases: [{ name: "Bad", tasks: [{}] }] } })).toBeNull();
  });
});
