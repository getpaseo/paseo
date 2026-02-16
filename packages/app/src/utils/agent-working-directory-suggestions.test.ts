import { describe, expect, it } from "vitest";
import { collectAgentWorkingDirectorySuggestions } from "@/utils/agent-working-directory-suggestions";

describe("collectAgentWorkingDirectorySuggestions", () => {
  it("deduplicates by cwd and sorts by most recent timestamp", () => {
    const results = collectAgentWorkingDirectorySuggestions([
      {
        cwd: "/Users/me/project-alpha",
        createdAt: new Date("2026-02-10T10:00:00.000Z"),
      },
      {
        cwd: "/Users/me/project-beta",
        createdAt: new Date("2026-02-11T10:00:00.000Z"),
      },
      {
        cwd: "/Users/me/project-alpha",
        lastActivityAt: new Date("2026-02-12T10:00:00.000Z"),
      },
    ]);

    expect(results).toEqual([
      "/Users/me/project-alpha",
      "/Users/me/project-beta",
    ]);
  });

  it("excludes Paseo-owned worktree paths", () => {
    const results = collectAgentWorkingDirectorySuggestions([
      {
        cwd: "/Users/me/repo/.paseo/worktrees/feature-a",
        createdAt: new Date("2026-02-12T10:00:00.000Z"),
      },
      {
        cwd: "/Users/me/repo",
        createdAt: new Date("2026-02-10T10:00:00.000Z"),
      },
      {
        cwd: "C:\\Users\\me\\repo\\.paseo\\worktrees\\feature-b",
        createdAt: new Date("2026-02-11T10:00:00.000Z"),
      },
    ]);

    expect(results).toEqual(["/Users/me/repo"]);
  });

  it("ignores empty cwd values", () => {
    const results = collectAgentWorkingDirectorySuggestions([
      { cwd: "   ", createdAt: new Date("2026-02-10T10:00:00.000Z") },
      { cwd: null, createdAt: new Date("2026-02-11T10:00:00.000Z") },
      { cwd: undefined, lastActivityAt: new Date("2026-02-12T10:00:00.000Z") },
      {
        cwd: "/Users/me/project",
        createdAt: new Date("2026-02-09T10:00:00.000Z"),
      },
    ]);

    expect(results).toEqual(["/Users/me/project"]);
  });
});
