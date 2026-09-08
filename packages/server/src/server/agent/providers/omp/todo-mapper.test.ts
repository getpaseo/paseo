import { describe, expect, test } from "vitest";

import { parseToolResult } from "./tool-call-detail.js";
import { mapOmpTodoState, mapOmpTodoToolResult } from "./todo-mapper.js";
import type { OmpSessionState } from "./rpc-types.js";

const TODO_PHASES = [
  {
    name: "Preparation",
    tasks: [
      { content: "Inspect", status: "completed" },
      { content: "Implement", status: "in_progress" },
      { content: "Document", status: "pending" },
    ],
  },
  {
    name: "Delivery",
    tasks: [
      { content: "Deploy", status: "blocked", blocker: "Waiting for approval" },
      { content: "Old rollout", status: "abandoned" },
    ],
  },
] as const;

const EXPECTED_TODO = {
  type: "todo",
  items: [
    {
      text: "Inspect",
      status: "completed",
      completed: true,
      state: "completed",
      phase: "Preparation",
      phaseIndex: 0,
    },
    {
      text: "Implement",
      status: "in_progress",
      completed: false,
      state: "in_progress",
      phase: "Preparation",
      phaseIndex: 0,
    },
    {
      text: "Document",
      status: "pending",
      completed: false,
      state: "pending",
      phase: "Preparation",
      phaseIndex: 0,
    },
    {
      text: "Deploy",
      status: "pending",
      completed: false,
      state: "blocked",
      phase: "Delivery",
      phaseIndex: 1,
      blocker: "Waiting for approval",
    },
    {
      text: "Old rollout",
      status: "completed",
      completed: true,
      state: "abandoned",
      phase: "Delivery",
      phaseIndex: 1,
    },
  ],
} as const;

const SESSION_STATE: OmpSessionState = {
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  sessionId: "session",
  messageCount: 0,
  queuedMessageCount: 0,
};

describe("OMP todo mapper", () => {
  test("preserves mixed states, phase order, and blocker reasons from todo results", () => {
    const result = parseToolResult({ content: [], details: { phases: TODO_PHASES } });

    expect(mapOmpTodoToolResult({ toolName: "todo", result })).toEqual(EXPECTED_TODO);
  });

  test("projects successful xd todo execution details and explicit clears", () => {
    const result = parseToolResult({
      content: [],
      details: { xdev: { tool: "todo", mode: "execute", inner: { phases: TODO_PHASES } } },
    });
    expect(mapOmpTodoToolResult({ toolName: "write", result })).toEqual(EXPECTED_TODO);
    expect(
      mapOmpTodoToolResult({
        toolName: "write",
        result: parseToolResult({
          content: [],
          details: { xdev: { tool: "todo", mode: "execute", inner: { phases: [] } } },
        }),
      }),
    ).toEqual({ type: "todo", items: [] });
  });

  test("does not treat documentation or another tool's phases as a todo snapshot", () => {
    expect(
      mapOmpTodoToolResult({
        toolName: "write",
        result: parseToolResult({
          content: [],
          details: { phases: TODO_PHASES },
        }),
      }),
    ).toBeNull();
    expect(
      mapOmpTodoToolResult({
        toolName: "write",
        result: parseToolResult({
          content: [],
          details: {
            xdev: { tool: "other_tool", mode: "execute", inner: { phases: TODO_PHASES } },
          },
        }),
      }),
    ).toBeNull();
    expect(
      mapOmpTodoToolResult({
        toolName: "write",
        result: parseToolResult({
          content: [],
          details: { xdev: { tool: "todo", mode: "docs", inner: { phases: TODO_PHASES } } },
        }),
      }),
    ).toBeNull();
  });

  test("does not project failed wrapped todo results even when phases are present", () => {
    expect(
      mapOmpTodoToolResult({
        toolName: "write",
        result: parseToolResult({
          content: [{ type: "text", text: "Todo update failed" }],
          isError: true,
          details: { xdev: { tool: "todo", mode: "execute", inner: { phases: TODO_PHASES } } },
        }),
      }),
    ).toBeNull();
  });

  test("hydrates the complete native snapshot without reopening abandoned work", () => {
    expect(mapOmpTodoState({ ...SESSION_STATE, todoPhases: TODO_PHASES })).toEqual([EXPECTED_TODO]);
  });

  test("distinguishes explicit clears from absent or malformed snapshots", () => {
    expect(
      mapOmpTodoToolResult({
        toolName: "todo",
        result: parseToolResult({ details: { phases: [] } }),
      }),
    ).toEqual({ type: "todo", items: [] });
    expect(mapOmpTodoState({ ...SESSION_STATE, todoPhases: [] })).toEqual([
      { type: "todo", items: [] },
    ]);
    expect(mapOmpTodoState(SESSION_STATE)).toEqual([]);
    expect(
      mapOmpTodoState({ ...SESSION_STATE, todoPhases: [{ name: "Bad", tasks: [{}] }] }),
    ).toEqual([]);
    expect(
      mapOmpTodoToolResult({
        toolName: "todo",
        result: parseToolResult({ details: { phases: [{ name: "Bad", tasks: [{}] }] } }),
      }),
    ).toBeNull();
  });

  test("rejects a malformed blocker instead of emitting an apparent clear", () => {
    expect(
      mapOmpTodoToolResult({
        toolName: "todo",
        result: parseToolResult({
          details: {
            phases: [
              { name: "Delivery", tasks: [{ content: "Deploy", status: "blocked", blocker: 1 }] },
            ],
          },
        }),
      }),
    ).toBeNull();
  });
});
