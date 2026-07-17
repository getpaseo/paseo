import { describe, expect, test } from "vitest";

import { parseToolResult } from "./tool-call-detail.js";
import { mapOmpTodoReminderEvent, mapOmpTodoState, mapOmpTodoToolResult } from "./todo-mapper.js";

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

describe("OMP todo mapper", () => {
  test("maps todo tool results and collapses statuses to completed booleans", () => {
    expect(
      mapOmpTodoToolResult(
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
        { text: "alpha task", completed: false },
        { text: "beta task", completed: false },
        { text: "gamma task", completed: false },
      ],
    });

    expect(
      mapOmpTodoToolResult(parseToolResult({ content: [], details: { phases: TODO_PHASES } })),
    ).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", completed: true },
        { text: "beta task", completed: false },
        { text: "gamma task", completed: false },
      ],
    });
  });

  test("maps todo reminder events", () => {
    expect(
      mapOmpTodoReminderEvent({
        type: "todo_reminder",
        todos: [
          { content: "beta task", status: "in_progress" },
          { content: "gamma task", status: "pending" },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        { text: "beta task", completed: false },
        { text: "gamma task", completed: false },
      ],
    });
  });

  test("hydrates current todos from session state", () => {
    expect(
      mapOmpTodoState({
        model: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        sessionId: "session",
        messageCount: 0,
        queuedMessageCount: 0,
        todoPhases: TODO_PHASES,
      }),
    ).toEqual([
      {
        type: "todo",
        items: [
          { text: "alpha task", completed: true },
          { text: "beta task", completed: false },
          { text: "gamma task", completed: false },
        ],
      },
    ]);
  });

  test("drops malformed todo inputs", () => {
    expect(mapOmpTodoReminderEvent({ type: "todo_reminder", todos: [{ content: 1 }] })).toBeNull();
    expect(
      mapOmpTodoToolResult({ details: { phases: [{ name: "Bad", tasks: [{}] }] } }),
    ).toBeNull();
  });
});
