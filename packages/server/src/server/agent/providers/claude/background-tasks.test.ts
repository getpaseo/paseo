import { describe, expect, test } from "vitest";

import { readClaudeBackgroundTasksChanged } from "./background-tasks.js";

describe("readClaudeBackgroundTasksChanged", () => {
  test("reads the live set Claude Code reports", () => {
    expect(
      readClaudeBackgroundTasksChanged({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "b1kxzuieg",
            run_id: "0mv6i61sl-c945893d",
            task_type: "local_bash",
            description: "Sleep 6 seconds then echo BG",
          },
          { task_id: "m1", task_type: "monitor" },
        ],
        uuid: "a63a1d17-5c7d-47c0-af33-c639be943957",
        session_id: "session-1",
      }),
    ).toEqual([
      { id: "b1kxzuieg", type: "local_bash", description: "Sleep 6 seconds then echo BG" },
      { id: "m1", type: "monitor", description: null },
    ]);
  });

  test("reads an empty set as nothing running", () => {
    expect(
      readClaudeBackgroundTasksChanged({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
      }),
    ).toEqual([]);
  });

  test("leaves backgrounded subagents and workflows to the subagents track", () => {
    expect(
      readClaudeBackgroundTasksChanged({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "a1", task_type: "local_agent", description: "Explore" },
          { task_id: "w1", task_type: "local_workflow", description: "Review" },
          { task_id: "b1", task_type: "local_bash", description: "ctest" },
        ],
      }),
    ).toEqual([{ id: "b1", type: "local_bash", description: "ctest" }]);
  });

  test("leaves out ambient housekeeping tasks", () => {
    expect(
      readClaudeBackgroundTasksChanged({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "h1", task_type: "local_bash", description: "Index", ambient: true },
          { task_id: "b1", task_type: "local_bash", description: "ctest" },
        ],
      }),
    ).toEqual([{ id: "b1", type: "local_bash", description: "ctest" }]);
  });

  test("ignores other system messages", () => {
    expect(
      readClaudeBackgroundTasksChanged({
        type: "system",
        subtype: "task_started",
        task_id: "b1",
        task_type: "local_bash",
      }),
    ).toBeNull();
  });
});
