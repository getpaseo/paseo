import { describe, expect, test } from "vitest";
import {
  appendBacklogTaskResolutionFooter,
  BACKLOG_PROJECT_ID_LABEL,
  BACKLOG_TASK_ID_LABEL,
  buildBacklogTaskLabels,
  formatBacklogTaskWorkspacePrompt,
} from "./prompt.js";

describe("backlog task prompt helpers", () => {
  test("formats workspace prompts with task ids and resolve instruction", () => {
    expect(
      formatBacklogTaskWorkspacePrompt({
        id: "task-1",
        projectId: "project-1",
        title: "Ship search",
        description: "Add backlog search",
      }),
    ).toBe(
      [
        "Ship search",
        "",
        "Add backlog search",
        "",
        "---",
        "Backlog task ID: task-1",
        "Backlog project ID: project-1",
        "When this work is complete, mark the backlog task resolved with resolve_backlog_task (taskId: task-1).",
      ].join("\n"),
    );
  });

  test("appends resolution footer without duplicating blank title bodies", () => {
    expect(
      appendBacklogTaskResolutionFooter("  Implement search  ", {
        id: "task-2",
        projectId: "project-2",
      }),
    ).toContain("Implement search");
  });

  test("builds durable backlog labels", () => {
    expect(buildBacklogTaskLabels({ id: "task-3", projectId: "project-3" })).toEqual({
      [BACKLOG_TASK_ID_LABEL]: "task-3",
      [BACKLOG_PROJECT_ID_LABEL]: "project-3",
    });
  });
});
