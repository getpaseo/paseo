import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { detectGitButler } from "./gitbutler.js";
import { commitWorkspaceChanges, snapshotWorkspace } from "./workspace-commit.js";

// Needs a repository set up with `but setup`; its path comes from the environment.
const repo = process.env.PASEO_TEST_GITBUTLER_REPO;

describe.skipIf(!repo)("workspace commits in a GitButler repository", () => {
  const cwd = repo ?? "";

  test("detects the repository as managed", async () => {
    await expect(detectGitButler(cwd)).resolves.toMatchObject({
      cliInstalled: true,
      repositoryManaged: true,
    });
  });

  test("commits only what the task changed and leaves earlier edits uncommitted", async () => {
    writeFileSync(path.join(cwd, "mine.txt"), "my own edit\n");
    const before = await snapshotWorkspace(cwd);
    expect(Object.keys(before)).toContain("mine.txt");

    writeFileSync(path.join(cwd, "task.txt"), "made by the task\n");
    const result = await commitWorkspaceChanges({
      cwd,
      before,
      branch: "paseo-goal/test-t1",
      message: "Task t1: demo",
    });
    expect(result).toEqual({ branch: "paseo-goal/test-t1", files: ["task.txt"] });

    const after = await snapshotWorkspace(cwd);
    expect(Object.keys(after)).toEqual(["mine.txt"]);
    expect(readFileSync(path.join(cwd, "mine.txt"), "utf8")).toBe("my own edit\n");
  });

  test("returns null when the task changed nothing", async () => {
    const before = await snapshotWorkspace(cwd);
    await expect(
      commitWorkspaceChanges({ cwd, before, branch: "paseo-goal/test-t2", message: "Task t2" }),
    ).resolves.toBeNull();
  });
});
