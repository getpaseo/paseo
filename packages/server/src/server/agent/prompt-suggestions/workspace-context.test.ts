import { describe, expect, it } from "vitest";
import type { RunGitCommand } from "../../../utils/run-git-command.js";
import { createWorkspaceContextReader } from "./workspace-context.js";

function fakeGit(outputs: Record<string, string | Error>): RunGitCommand {
  return (async (args: string[]) => {
    const joined = args.join(" ");
    const key = Object.keys(outputs).find((candidate) => joined.includes(candidate));
    const value = key === undefined ? undefined : outputs[key];
    if (value instanceof Error) {
      throw value;
    }
    if (value === undefined) {
      return { stdout: "", stderr: "", truncated: false, exitCode: 1, signal: null };
    }
    return { stdout: value, stderr: "", truncated: false, exitCode: 0, signal: null };
  }) as RunGitCommand;
}

const INSIDE = { "is-inside-work-tree": "true\n" };

describe("createWorkspaceContextReader", () => {
  it("reads the branch, the changed paths and the recent subjects", async () => {
    const read = createWorkspaceContextReader({
      runGit: (async (args: string[], options: { cwd: string }) => {
        expect(options.cwd).toBe("/repo");
        const joined = args.join(" ");
        if (joined.startsWith("rev-parse --is-inside-work-tree")) {
          return { stdout: "true\n", stderr: "", truncated: false, exitCode: 0, signal: null };
        }
        if (joined.startsWith("rev-parse")) {
          return {
            stdout: "feat/thing\n",
            stderr: "",
            truncated: false,
            exitCode: 0,
            signal: null,
          };
        }
        if (joined.startsWith("status")) {
          return {
            stdout: " M src/a.ts\0R  src/new.ts\0src/old.ts\0?? notes my file.md\0",
            stderr: "",
            truncated: false,
            exitCode: 0,
            signal: null,
          };
        }
        return {
          stdout: "first subject\nsecond subject\n",
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      }) as RunGitCommand,
    });

    // The rename's source path must not be read as a changed file of its own.
    expect(await read("/repo")).toEqual({
      branch: "feat/thing",
      changedPaths: ["src/a.ts", "src/new.ts", "notes my file.md"],
      recentCommits: ["first subject", "second subject"],
      moreChangedPaths: 0,
    });
  });

  it("returns nothing outside a repository", async () => {
    const read = createWorkspaceContextReader({ runGit: fakeGit({}) });
    expect(await read("/not-a-repo")).toBeNull();
  });

  it("returns nothing for a repository with no branch, commits or changes", async () => {
    const read = createWorkspaceContextReader({
      runGit: fakeGit({ ...INSIDE, status: "", log: "" }),
    });
    expect(await read("/repo")).toBeNull();
  });

  it("survives a git invocation that throws", async () => {
    const read = createWorkspaceContextReader({
      runGit: fakeGit({ "is-inside-work-tree": new Error("git is missing") }),
    });
    expect(await read("/repo")).toBeNull();
  });

  it("caps the file list and reports how many it left out", async () => {
    const paths = Array.from({ length: 30 }, (_, index) => ` M src/file${index}.ts`).join("\0");
    const read = createWorkspaceContextReader({
      runGit: fakeGit({ ...INSIDE, status: `${paths}\0`, log: "only subject\n" }),
    });

    const context = await read("/repo");
    expect(context?.changedPaths).toHaveLength(25);
    expect(context?.moreChangedPaths).toBe(5);
  });
});
