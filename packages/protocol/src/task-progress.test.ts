import { describe, expect, it } from "vitest";

import {
  applyTaskDelta,
  buildTaskProgress,
  extractTaskDeltaFromToolCall,
  extractTaskEntriesFromToolCall,
  taskEntriesToProgress,
  type TaskEntryWithId,
} from "./task-progress.js";

describe("extractTaskEntriesFromToolCall", () => {
  it("extracts TodoWrite entries with three-way status", () => {
    const tasks = extractTaskEntriesFromToolCall("TodoWrite", {
      todos: [
        { content: "Task 1", status: "pending" },
        { content: "Task 2", status: "in_progress" },
        { content: "Task 3", status: "completed" },
      ],
    });

    expect(tasks?.map((task) => task.status)).toEqual(["pending", "in_progress", "completed"]);
    expect(tasks?.map((task) => task.completed)).toEqual([false, false, true]);
  });

  it("prefers activeForm over content for the text", () => {
    const tasks = extractTaskEntriesFromToolCall("TodoWrite", {
      todos: [{ content: "Write tests", status: "in_progress", activeForm: "Writing tests" }],
    });

    expect(tasks?.[0]?.text).toBe("Writing tests");
  });

  it("normalizes separator variants of the tool name", () => {
    for (const name of ["todo.write", "todo-write", "Todo Write", "todo_write"]) {
      expect(extractTaskEntriesFromToolCall(name, { todos: [] })).toEqual([]);
    }
  });

  it("returns null for non task-list tools and ExitPlanMode", () => {
    expect(extractTaskEntriesFromToolCall("Bash", { command: "ls" })).toBeNull();
    expect(extractTaskEntriesFromToolCall("ExitPlanMode", { plan: "x" })).toBeNull();
  });

  it("parses Codex UpdatePlan steps", () => {
    const tasks = extractTaskEntriesFromToolCall("update_plan", {
      plan: [
        { step: "Investigate", status: "completed" },
        { step: "Implement", status: "pending" },
      ],
    });

    expect(tasks?.map((task) => task.text)).toEqual(["Investigate", "Implement"]);
  });
});

describe("extractTaskDeltaFromToolCall", () => {
  it("parses TaskCreate into a create delta (pending)", () => {
    const delta = extractTaskDeltaFromToolCall("TaskCreate", {
      subject: "Build the CLI",
      description: "long form",
    });
    expect(delta).toEqual({ kind: "create", text: "Build the CLI", status: "pending" });
  });

  it("prefers activeForm over subject for create text", () => {
    const delta = extractTaskDeltaFromToolCall("TaskCreate", {
      subject: "Build the CLI",
      activeForm: "Building the CLI",
    });
    expect(delta).toMatchObject({ kind: "create", text: "Building the CLI" });
  });

  it("parses TaskUpdate status changes", () => {
    expect(
      extractTaskDeltaFromToolCall("TaskUpdate", { taskId: 2, status: "in_progress" }),
    ).toEqual({ kind: "update", id: "2", status: "in_progress" });
  });

  it("maps TaskUpdate deleted status to a delete delta", () => {
    expect(extractTaskDeltaFromToolCall("TaskUpdate", { taskId: "3", status: "deleted" })).toEqual({
      kind: "delete",
      id: "3",
    });
  });

  it("normalizes separator variants of the task tool names", () => {
    for (const name of ["TaskCreate", "taskcreate", "task_create", "task.create", "Task Create"]) {
      expect(extractTaskDeltaFromToolCall(name, { subject: "x" })).toMatchObject({
        kind: "create",
      });
    }
  });

  it("returns null for unrelated tools", () => {
    expect(extractTaskDeltaFromToolCall("Bash", { command: "ls" })).toBeNull();
    expect(extractTaskDeltaFromToolCall("TodoWrite", { todos: [] })).toBeNull();
  });
});

describe("applyTaskDelta", () => {
  it("appends on create, assigning a positional logical id", () => {
    const after = applyTaskDelta([], { kind: "create", text: "a", status: "pending" }, "call-1");
    expect(after).toEqual([{ id: "1", callId: "call-1", text: "a", status: "pending" }]);
  });

  it("dedupes a create recorded twice under the same callId", () => {
    let entries = applyTaskDelta([], { kind: "create", text: "a", status: "pending" }, "call-1");
    // Same call recorded again (running → completed) with fuller text.
    entries = applyTaskDelta(
      entries,
      { kind: "create", text: "Task A", status: "pending" },
      "call-1",
    );
    expect(entries).toEqual([{ id: "1", callId: "call-1", text: "Task A", status: "pending" }]);
  });

  it("mutates status of the matching logical id on update", () => {
    const start: TaskEntryWithId[] = [{ id: "1", callId: "c1", text: "a", status: "pending" }];
    expect(applyTaskDelta(start, { kind: "update", id: "1", status: "completed" })).toEqual([
      { id: "1", callId: "c1", text: "a", status: "completed" },
    ]);
  });

  it("drops the matching logical id on delete", () => {
    const start: TaskEntryWithId[] = [
      { id: "1", text: "a", status: "pending" },
      { id: "2", text: "b", status: "pending" },
    ];
    expect(applyTaskDelta(start, { kind: "delete", id: "1" })).toEqual([
      { id: "2", text: "b", status: "pending" },
    ]);
  });

  it("assigns a non-colliding id after a deletion shrinks the list", () => {
    // Regression: create 1, 2 → delete 1 → create → must NOT reuse "2".
    let entries = applyTaskDelta([], { kind: "create", text: "a", status: "pending" }, "c1");
    entries = applyTaskDelta(entries, { kind: "create", text: "b", status: "pending" }, "c2");
    entries = applyTaskDelta(entries, { kind: "delete", id: "1" });
    entries = applyTaskDelta(entries, { kind: "create", text: "c", status: "pending" }, "c3");
    expect(entries.map((entry) => entry.id)).toEqual(["2", "3"]);
  });

  it("is a no-op when updating an unknown id", () => {
    const start: TaskEntryWithId[] = [{ id: "1", text: "a", status: "pending" }];
    expect(applyTaskDelta(start, { kind: "update", id: "99", status: "completed" })).toBe(start);
  });

  it("accumulates a create/update sequence into the expected counts", () => {
    let entries: TaskEntryWithId[] = [];
    ["a", "b", "c"].forEach((text, index) => {
      entries = applyTaskDelta(
        entries,
        { kind: "create", text, status: "pending" },
        `call-${index}`,
      );
    });
    entries = applyTaskDelta(entries, { kind: "update", id: "1", status: "in_progress" });
    entries = applyTaskDelta(entries, { kind: "update", id: "1", status: "completed" });
    const progress = taskEntriesToProgress(entries, "2026-06-28T00:00:00.000Z");
    expect(progress).toMatchObject({ pending: 2, inProgress: 0, completed: 1, total: 3 });
  });
});

describe("buildTaskProgress", () => {
  it("aggregates counts and preserves order", () => {
    const entries = extractTaskEntriesFromToolCall("TodoWrite", {
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
        { content: "d", status: "pending" },
      ],
    });

    const progress = buildTaskProgress(entries ?? [], "2026-06-28T00:00:00.000Z");

    expect(progress).toEqual({
      items: [
        { text: "a", status: "completed" },
        { text: "b", status: "in_progress" },
        { text: "c", status: "pending" },
        { text: "d", status: "pending" },
      ],
      pending: 2,
      inProgress: 1,
      completed: 1,
      total: 4,
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
  });
});
