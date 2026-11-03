import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

describe("workspace commits in a plain git repository", () => {
  let cwd = "";
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "paseo-plain-git-"));
    git("init", "-q", "-b", "work");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(path.join(cwd, "base.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("commits the task's files on the current branch and leaves earlier edits alone", async () => {
    writeFileSync(path.join(cwd, "base.txt"), "my edit\n");
    git("add", "base.txt");
    const before = await snapshotWorkspace(cwd);
    expect(Object.keys(before)).toEqual(["base.txt"]);

    mkdirSync(path.join(cwd, "src"));
    writeFileSync(path.join(cwd, "src", "new.ts"), "export {};\n");
    const result = await commitWorkspaceChanges({
      cwd,
      before,
      branch: "ignored/branch",
      message: "Task t1: demo",
    });
    expect(result).toEqual({ branch: "work", files: ["src/new.ts"] });
    expect(git("branch", "--show-current")).toBe("work");
    expect(git("log", "-1", "--format=%s")).toBe("Task t1: demo");
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("src/new.ts");
    // The edit staged before the task is still staged, not committed.
    expect(git("diff", "--cached", "--name-only")).toBe("base.txt");
    expect(readFileSync(path.join(cwd, "base.txt"), "utf8")).toBe("my edit\n");
  });

  test("commits only files inside what the task declared", async () => {
    const before = await snapshotWorkspace(cwd);
    mkdirSync(path.join(cwd, "a"));
    mkdirSync(path.join(cwd, "b"));
    writeFileSync(path.join(cwd, "a", "x.ts"), "a\n");
    writeFileSync(path.join(cwd, "b", "y.ts"), "b\n");
    const result = await commitWorkspaceChanges({
      cwd,
      before,
      branch: "x",
      message: "Task t2",
      include: (filePath) => filePath.startsWith("a/"),
    });
    expect(result?.files).toEqual(["a/x.ts"]);
    expect(git("status", "--porcelain")).toBe("?? b/");
  });

  test("returns null when nothing changed, and two commits at once both land", async () => {
    const before = await snapshotWorkspace(cwd);
    await expect(
      commitWorkspaceChanges({ cwd, before, branch: "x", message: "none" }),
    ).resolves.toBeNull();

    writeFileSync(path.join(cwd, "one.txt"), "1\n");
    writeFileSync(path.join(cwd, "two.txt"), "2\n");
    const [first, second] = await Promise.all([
      commitWorkspaceChanges({
        cwd,
        before,
        branch: "x",
        message: "one",
        include: (f) => f === "one.txt",
      }),
      commitWorkspaceChanges({
        cwd,
        before,
        branch: "x",
        message: "two",
        include: (f) => f === "two.txt",
      }),
    ]);
    expect(first?.files).toEqual(["one.txt"]);
    expect(second?.files).toEqual(["two.txt"]);
    expect(git("status", "--porcelain")).toBe("");
  });
});
