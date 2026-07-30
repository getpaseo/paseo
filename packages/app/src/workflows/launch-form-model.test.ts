import { describe, expect, it } from "vitest";
import type { WorkflowValidationResult } from "@getpaseo/protocol/workflow/types";
import {
  openWorkflowLaunchForm,
  submitWorkflowLaunchForm,
  updateWorkflowLaunchValue,
} from "./launch-form-model";

const validation: WorkflowValidationResult = {
  valid: true,
  issues: [],
  summary: null,
  parameters: [
    {
      name: "objective",
      type: "string",
      description: "Goal",
      required: true,
    },
    {
      name: "concurrency",
      type: "integer",
      description: "Workers",
      required: false,
      defaultValue: 2,
    },
    {
      name: "repo",
      type: "path",
      description: "Repository",
      required: true,
      defaultFrom: "current.worktree",
    },
  ],
};

describe("workflow launch form model", () => {
  it("keeps current bindings empty and parses declared parameter types", () => {
    let form = openWorkflowLaunchForm(validation);
    expect(form.values).toEqual({ objective: "", concurrency: "2", repo: "" });
    form = updateWorkflowLaunchValue(form, "objective", "ship it");
    expect(submitWorkflowLaunchForm(form, validation)).toEqual({
      ok: true,
      parameters: { objective: "ship it", concurrency: 2 },
    });
  });

  it("returns field errors without discarding entered values", () => {
    let form = openWorkflowLaunchForm(validation);
    form = updateWorkflowLaunchValue(form, "concurrency", "many");
    const result = submitWorkflowLaunchForm(form, validation);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.form.values.concurrency).toBe("many");
      expect(result.form.errors).toEqual({
        objective: "Required",
        concurrency: "Enter an integer",
      });
    }
  });
});
