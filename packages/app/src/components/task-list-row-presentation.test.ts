import { describe, expect, it } from "vitest";
import { buildTaskRowPresentation } from "./task-list-row-presentation";

describe("buildTaskRowPresentation", () => {
  it("marks a task the agent has not started yet as pending", () => {
    expect(buildTaskRowPresentation({ text: "Queued", completed: false })).toEqual({
      mark: "pending",
      text: "Queued",
    });
  });

  it("names the running task by the present-tense form the agent supplied", () => {
    expect(
      buildTaskRowPresentation({
        text: "Run checks",
        activeForm: "Running checks",
        completed: false,
        status: "in_progress",
      }),
    ).toEqual({ mark: "running", text: "Running checks" });
  });

  it("falls back to the plain text when a running task carries no active form", () => {
    expect(
      buildTaskRowPresentation({ text: "Run checks", completed: false, status: "in_progress" }),
    ).toEqual({ mark: "running", text: "Run checks" });
  });

  it("treats a completed flag as done even while the status still says in progress", () => {
    // Providers report the two separately, and they disagree while a write is in flight.
    expect(
      buildTaskRowPresentation({
        text: "Run checks",
        activeForm: "Running checks",
        completed: true,
        status: "in_progress",
      }),
    ).toEqual({ mark: "done", text: "Run checks" });
  });

  it("treats a completed status as done without the flag", () => {
    expect(
      buildTaskRowPresentation({ text: "Finished", completed: false, status: "completed" }),
    ).toEqual({ mark: "done", text: "Finished" });
  });
});
