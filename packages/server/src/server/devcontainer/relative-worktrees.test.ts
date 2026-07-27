import { describe, expect, it } from "vitest";
import { parseGitVersion, versionSupportsRelativeWorktrees } from "./relative-worktrees.js";

describe("relative worktree support", () => {
  it("reads a git version string", () => {
    expect(parseGitVersion("git version 2.48.1\n")).toEqual({ major: 2, minor: 48 });
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual({ major: 2, minor: 39 });
    expect(parseGitVersion("not git at all")).toBeNull();
  });

  it("draws the line at 2.48, where relative worktrees arrived", () => {
    // Below the line the repository extension is unreadable, so the worktree
    // has to be created the ordinary way instead.
    expect(versionSupportsRelativeWorktrees("git version 2.47.9")).toBe(false);
    expect(versionSupportsRelativeWorktrees("git version 2.48.0")).toBe(true);
    expect(versionSupportsRelativeWorktrees("git version 2.55.0")).toBe(true);
    expect(versionSupportsRelativeWorktrees("git version 3.0.0")).toBe(true);
  });

  it("treats an unreadable answer as unsupported", () => {
    // An image with no git at all, or one whose output we cannot parse, must
    // not be assumed capable: the cost of guessing wrong lands on the user's
    // repository, not on Paseo.
    expect(versionSupportsRelativeWorktrees("")).toBe(false);
    expect(versionSupportsRelativeWorktrees("git: not found")).toBe(false);
  });
});
