import { describe, expect, it } from "vitest";
import { BackgroundTaskStore } from "../../background-tasks/store.js";
import {
  applyClaudeBackgroundSystemMessage,
  extractBashBackgroundTaskCorrelation,
  mapClaudeBackgroundSystemMessage,
} from "./background-tasks.js";

const PARENT = "00000000-0000-4000-8000-000000000001";

describe("mapClaudeBackgroundSystemMessage", () => {
  it("maps background_tasks_changed to replace", () => {
    const event = mapClaudeBackgroundSystemMessage(
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "s1", task_type: "shell", description: "npm run dev" },
          { task_id: "a1", task_type: "subagent", description: "Explore" },
        ],
      },
      "2026-08-01T00:00:00.000Z",
    );
    expect(event).toEqual({
      kind: "replace",
      at: "2026-08-01T00:00:00.000Z",
      tasks: [
        { taskId: "s1", type: "shell", description: "npm run dev" },
        { taskId: "a1", type: "subagent", description: "Explore" },
      ],
    });
  });
});

describe("applyClaudeBackgroundSystemMessage", () => {
  it("replaces live set from background_tasks_changed shell-only", () => {
    const store = new BackgroundTaskStore();
    const result = applyClaudeBackgroundSystemMessage(
      store,
      PARENT,
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "s1", task_type: "shell", description: "npm run dev" },
          { task_id: "x1", task_type: "subagent", description: "Explore" },
        ],
      },
      "2026-08-01T00:00:00.000Z",
    );
    expect(result.changed).toBe(true);
    expect(result.tasks.map((t) => t.taskId)).toEqual(["s1"]);
  });

  it("enriches status and output file from task_notification", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "npm run dev" }],
      "2026-08-01T00:00:00.000Z",
    );
    applyClaudeBackgroundSystemMessage(
      store,
      PARENT,
      {
        type: "system",
        subtype: "task_notification",
        task_id: "s1",
        status: "stopped",
        summary: "stopped",
        output_file: "/tmp/s1.log",
      },
      "2026-08-01T00:00:01.000Z",
    );
    expect(store.get(PARENT, "s1")?.outputFile).toBe("/tmp/s1.log");
    expect(store.get(PARENT, "s1")?.status).toBe("stopped");
  });

  it("task_started merges without wiping other live shell tasks", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "one" }],
      "2026-08-01T00:00:00.000Z",
    );
    const result = applyClaudeBackgroundSystemMessage(
      store,
      PARENT,
      {
        type: "system",
        subtype: "task_started",
        task_id: "s2",
        task_type: "shell",
        description: "two",
      },
      "2026-08-01T00:00:02.000Z",
    );
    expect(result.tasks.map((t) => t.taskId).sort()).toEqual(["s1", "s2"]);
  });
});

describe("extractBashBackgroundTaskCorrelation", () => {
  it("extracts backgroundTaskId and command from bash tool result", () => {
    expect(
      extractBashBackgroundTaskCorrelation({
        toolName: "Bash",
        toolInput: { command: "npm run dev" },
        toolOutput: { backgroundTaskId: "bg-9", stdout: "started" },
      }),
    ).toEqual({ taskId: "bg-9", command: "npm run dev" });
  });

  it("returns null for non-shell tools", () => {
    expect(
      extractBashBackgroundTaskCorrelation({
        toolName: "Read",
        toolInput: { file_path: "a.ts" },
        toolOutput: { backgroundTaskId: "bg-9" },
      }),
    ).toBeNull();
  });
});
