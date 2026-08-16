import { describe, expect, test } from "vitest";

import { parseToolResult } from "./tool-call-mapper.js";
import { canMapPiTodoToolResult, mapPiTodoToolResult } from "./todo-mapper.js";

const SAMPLE_TASKS = [
  { id: 1, subject: "泡一杯咖啡", status: "pending" },
  { id: 2, subject: "检查今日邮件", status: "in_progress" },
  { id: 3, subject: "写一段代码", status: "completed" },
  { id: 4, subject: "已删除的任务", status: "deleted" },
] as const;

describe("Pi todo mapper", () => {
  test("maps todo tool result to TodoListCard items", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: "Created #1: 泡一杯咖啡 (pending)" }],
      details: {
        action: "create",
        params: { action: "create", subject: "泡一杯咖啡" },
        tasks: SAMPLE_TASKS,
        nextId: 5,
      },
    });

    expect(mapPiTodoToolResult(result)).toEqual({
      type: "todo",
      items: [
        { text: "泡一杯咖啡", completed: false },
        { text: "检查今日邮件", completed: false },
        { text: "写一段代码", completed: true },
      ],
    });
  });

  test("in_progress maps to completed: false (not completed)", () => {
    const result = parseToolResult({
      content: [],
      details: {
        action: "list",
        params: { action: "list" },
        tasks: [
          { id: 1, subject: "进行中的任务", status: "in_progress" },
          { id: 2, subject: "已完成的任务", status: "completed" },
          { id: 3, subject: "待处理的任务", status: "pending" },
        ],
        nextId: 4,
      },
    });

    expect(mapPiTodoToolResult(result)).toEqual({
      type: "todo",
      items: [
        { text: "进行中的任务", completed: false },
        { text: "已完成的任务", completed: true },
        { text: "待处理的任务", completed: false },
      ],
    });
  });

  test("filters out deleted tasks", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: "Deleted #1" }],
      details: {
        action: "delete",
        params: { action: "delete", id: 1 },
        tasks: [
          { id: 1, subject: "已删除的任务", status: "deleted" },
          { id: 2, subject: "活着的任务", status: "pending" },
          { id: 3, subject: "另一个已删除的任务", status: "deleted" },
        ],
        nextId: 4,
      },
    });

    expect(mapPiTodoToolResult(result)).toEqual({
      type: "todo",
      items: [{ text: "活着的任务", completed: false }],
    });
  });

  test("clears the card with empty items when all tasks are deleted", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: "Cleared 2 tasks" }],
      details: {
        action: "clear",
        params: { action: "clear" },
        tasks: [
          { id: 1, subject: "已删除 1", status: "deleted" },
          { id: 2, subject: "已删除 2", status: "deleted" },
        ],
        nextId: 3,
      },
    });

    expect(mapPiTodoToolResult(result)).toEqual({
      type: "todo",
      items: [],
    });
  });

  test("clears the card with empty items when the list is empty", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: "No tasks" }],
      details: {
        action: "list",
        params: { action: "list" },
        tasks: [],
        nextId: 1,
      },
    });

    expect(mapPiTodoToolResult(result)).toEqual({
      type: "todo",
      items: [],
    });
  });

  test("canMapPiTodoToolResult distinguishes renderable snapshots from malformed input", () => {
    expect(canMapPiTodoToolResult(null)).toBe(false);
    expect(canMapPiTodoToolResult("not an object")).toBe(false);
    expect(canMapPiTodoToolResult({})).toBe(false);
    expect(canMapPiTodoToolResult({ details: { tasks: "not an array" } })).toBe(false);
    expect(canMapPiTodoToolResult({ details: {} })).toBe(false);
    expect(
      canMapPiTodoToolResult({ details: { tasks: [{ id: "not a number", subject: 123 }] } }),
    ).toBe(false);
    expect(
      canMapPiTodoToolResult({
        details: {
          tasks: [
            { id: 1, subject: "正常任务", status: "pending" },
            { id: "bad", status: "pending" },
          ],
        },
      }),
    ).toBe(false);

    expect(
      canMapPiTodoToolResult({
        details: { action: "list", params: { action: "list" }, tasks: [], nextId: 1 },
      }),
    ).toBe(true);
    expect(
      canMapPiTodoToolResult({
        details: { tasks: [{ id: 1, subject: "x", status: "pending" }] },
      }),
    ).toBe(true);
  });

  test("returns null for malformed input", () => {
    expect(mapPiTodoToolResult(null)).toBeNull();
    expect(mapPiTodoToolResult("not an object")).toBeNull();
    expect(mapPiTodoToolResult({})).toBeNull();
    expect(mapPiTodoToolResult({ details: { tasks: "not an array" } })).toBeNull();
  });

  test("treats an array of malformed tasks as unrenderable (fallback, not a clear)", () => {
    expect(
      mapPiTodoToolResult({ details: { tasks: [{ id: "not a number", subject: 123 }] } }),
    ).toBeNull();
    expect(
      mapPiTodoToolResult({ details: { tasks: [{ id: 1 }, { subject: "no id" }] } }),
    ).toBeNull();
  });

  test("treats a partially malformed task array as unrenderable (fallback, not partial list)", () => {
    const result = parseToolResult({
      content: [],
      details: {
        action: "list",
        params: { action: "list" },
        tasks: [
          { id: 1, subject: "正常任务", status: "pending" },
          { id: "bad", status: "pending" }, // missing subject
          { subject: "无ID", status: "completed" }, // missing id
          {}, // nothing valid
        ],
        nextId: 4,
      },
    });

    expect(mapPiTodoToolResult(result)).toBeNull();
  });
});
