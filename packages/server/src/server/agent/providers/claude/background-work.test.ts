import { describe, expect, test } from "vitest";

import { toBackgroundWorkInputs } from "./background-work.js";

describe("toBackgroundWorkInputs", () => {
  test("maps shells and monitors, drops subagents and workflows", () => {
    expect(
      toBackgroundWorkInputs([
        { task_id: "bash-1", task_type: "local_bash", description: "sleep 20" },
        { task_id: "agent-1", task_type: "local_agent", description: "Explore" },
        { task_id: "wf-1", task_type: "local_workflow", description: "Run the spec workflow" },
        { task_id: "mon-1", task_type: "local_monitor", description: "Watch CI" },
        { task_id: "x-1", task_type: "remote_something", description: "  " },
      ]),
    ).toEqual([
      { id: "bash-1", kind: "shell", description: "sleep 20" },
      { id: "mon-1", kind: "monitor", description: "Watch CI" },
      { id: "x-1", kind: "other", description: null },
    ]);
  });
});
