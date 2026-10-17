import { describe, expect, it } from "vitest";
import { buildBackgroundTasksPillPresentation, resolveBackgroundTaskKind } from "./presentation";

describe("resolveBackgroundTaskKind", () => {
  it("names Claude's background Bash commands shells", () => {
    expect(resolveBackgroundTaskKind("local_bash")).toBe("shell");
  });

  it("names monitor watches monitors", () => {
    expect(resolveBackgroundTaskKind("monitor")).toBe("monitor");
    expect(resolveBackgroundTaskKind("local_monitor")).toBe("monitor");
  });

  it("keeps unknown provider task types generic", () => {
    expect(resolveBackgroundTaskKind("remote_agent")).toBe("other");
  });
});

describe("buildBackgroundTasksPillPresentation", () => {
  it("counts shells as shells, like the Claude Code footer", () => {
    expect(
      buildBackgroundTasksPillPresentation([
        { id: "a", type: "local_bash", description: "ctest" },
        { id: "b", type: "local_bash", description: null },
      ]),
    ).toEqual({ noun: "shell", count: 2 });
  });

  it("falls back to background tasks for a mixed set", () => {
    expect(
      buildBackgroundTasksPillPresentation([
        { id: "a", type: "local_bash", description: "ctest" },
        { id: "b", type: "monitor", description: "tail log" },
      ]),
    ).toEqual({ noun: "task", count: 2 });
  });
});
