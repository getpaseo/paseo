import { describe, expect, test } from "vitest";
import { ClaudeTaskState } from "./task-state.js";

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

function toolResult(id: string, result: Record<string, unknown>) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    toolUseResult: result,
  };
}

describe("ClaudeTaskState", () => {
  test("accumulates TaskCreate and TaskUpdate mutations by task id", () => {
    const state = new ClaudeTaskState();
    state.observe(
      toolUse("create-1", "TaskCreate", { subject: "Alpha", activeForm: "Doing alpha" }),
    );
    expect(state.observe(toolResult("create-1", { task: { id: "1", subject: "Alpha" } }))).toEqual({
      type: "todo",
      items: [
        { id: "1", text: "Alpha", activeForm: "Doing alpha", status: "pending", completed: false },
      ],
    });

    state.observe(toolUse("update-1", "TaskUpdate", { taskId: "1", status: "in_progress" }));
    expect(state.observe(toolResult("update-1", { success: true, taskId: "1" }))).toEqual({
      type: "todo",
      items: [
        {
          id: "1",
          text: "Alpha",
          activeForm: "Doing alpha",
          status: "in_progress",
          completed: false,
        },
      ],
    });
  });

  test("removes deleted tasks and ignores replayed results", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create", "TaskCreate", { subject: "Disposable" }));
    state.observe(toolResult("create", { task: { id: "1", subject: "Disposable" } }));
    state.observe(toolUse("delete", "TaskUpdate", { taskId: "1", status: "deleted" }));
    const result = toolResult("delete", { success: true, taskId: "1" });
    expect(state.observe(result)).toEqual({ type: "todo", items: [] });
    expect(state.observe(result)).toBeNull();
  });

  test("preserves status when TaskUpdate changes only descriptive fields", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create", "TaskCreate", { subject: "Original" }));
    state.observe(toolResult("create", { task: { id: "1", subject: "Original" } }));
    state.observe(toolUse("complete", "TaskUpdate", { taskId: "1", status: "completed" }));
    state.observe(toolResult("complete", { success: true, taskId: "1" }));
    state.observe(toolUse("rename", "TaskUpdate", { taskId: "1", subject: "Renamed" }));

    expect(state.observe(toolResult("rename", { success: true, taskId: "1" }))).toEqual({
      type: "todo",
      items: [{ id: "1", text: "Renamed", status: "completed", completed: true }],
    });
  });

  test("replaces state from TodoWrite and TaskList snapshots", () => {
    const state = new ClaudeTaskState();
    expect(
      state.observe(
        toolUse("legacy", "TodoWrite", {
          todos: [{ content: "Legacy", status: "in_progress", activeForm: "Working" }],
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "legacy:0",
          text: "Legacy",
          activeForm: "Working",
          status: "in_progress",
          completed: false,
        },
      ],
    });
    state.observe(toolUse("list", "TaskList", {}));
    expect(
      state.observe(
        toolResult("list", {
          tasks: [{ id: "7", subject: "Current", status: "completed", activeForm: "Finishing" }],
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        { id: "7", text: "Current", activeForm: "Finishing", status: "completed", completed: true },
      ],
    });
  });

  test("keeps synthetic TodoWrite task ids stable across snapshots", () => {
    const state = new ClaudeTaskState();
    state.observe(
      toolUse("first", "TodoWrite", {
        todos: [{ content: "Stable", status: "pending" }],
      }),
    );

    expect(
      state.observe(
        toolUse("second", "TodoWrite", {
          todos: [{ content: "Stable", status: "completed" }],
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [{ id: "legacy:0", text: "Stable", status: "completed", completed: true }],
    });
  });

  test("does not confuse Claude's subagent Task tool with task tracking", () => {
    const state = new ClaudeTaskState();
    expect(state.observe(toolUse("subagent", "Task", { description: "delegate" }))).toBeNull();
  });
});
