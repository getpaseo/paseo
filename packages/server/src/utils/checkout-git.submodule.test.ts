import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getCheckoutDiff } from "./checkout-git.js";

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-git-sub-")));
  repos.push(tempDir);
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.email", "test@test.com");
  git(repoDir, "config", "user.name", "Test");
  writeFileSync(join(repoDir, "file.txt"), "hello\n");
  git(repoDir, "add", ".");
  git(repoDir, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
  return repoDir;
}

function addNestedSubmodule(repoDir: string, subPath = "libs/sub"): string {
  const subDir = join(repoDir, subPath);
  mkdirSync(subDir, { recursive: true });
  git(subDir, "init", "-b", "main");
  git(subDir, "config", "user.email", "test@test.com");
  git(subDir, "config", "user.name", "Test");
  writeFileSync(join(subDir, "nested.txt"), "sub\n");
  git(subDir, "add", ".");
  git(subDir, "-c", "commit.gpgsign=false", "commit", "-m", "subinit");
  const sha = git(subDir, "rev-parse", "HEAD");

  writeFileSync(
    join(repoDir, ".gitmodules"),
    `[submodule "${subPath}"]\n\tpath = ${subPath}\n\turl = ./${subPath}\n`,
  );
  git(repoDir, "update-index", "--add", "--cacheinfo", `160000,${sha},${subPath}`);
  git(repoDir, "add", ".gitmodules");
  git(repoDir, "-c", "commit.gpgsign=false", "commit", "-m", "add submodule");
  return subDir;
}

describe("getCheckoutDiff submodule expansion", () => {
  it("keeps gitlink stubs when expandSubmodules is omitted (default)", async () => {
    const repoDir = initRepo();
    const subDir = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "nested.txt"), "sub\nchanged\n");

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(result.diff).toMatch(/Subproject commit/i);
    expect(result.structured?.some((file) => file.path === "libs/sub/nested.txt")).toBeFalsy();
  });

  it("expands dirty submodule file edits into structured file hunks when enabled", async () => {
    const repoDir = initRepo();
    const subDir = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "nested.txt"), "sub\nchanged\n");

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
      expandSubmodules: true,
    });

    expect(result.diff).not.toContain("Subproject commit");
    expect(result.structured?.some((file) => file.path === "libs/sub")).toBe(false);

    const nested = result.structured?.find((file) => file.path === "libs/sub/nested.txt");
    expect(nested).toBeDefined();
    expect(nested?.status).toBe("ok");
    expect(nested?.hunks.length).toBeGreaterThan(0);
    expect(nested?.hunks.flatMap((hunk) => hunk.lines)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "add", content: "changed" })]),
    );
    expect(result.diff).toContain("libs/sub/nested.txt");
  });

  it("includes untracked files inside dirty submodules when enabled", async () => {
    const repoDir = initRepo();
    const subDir = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "extra.txt"), "untracked\n");

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
      expandSubmodules: true,
    });

    expect(result.diff).not.toContain("Subproject commit");
    const extra = result.structured?.find((file) => file.path === "libs/sub/extra.txt");
    expect(extra).toBeDefined();
    expect(extra?.isNew).toBe(true);
    expect(extra?.hunks.flatMap((hunk) => hunk.lines)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "add", content: "untracked" })]),
    );
  });

  it("expands submodule pointer moves into file-level diffs when enabled", async () => {
    const repoDir = initRepo();
    const subDir = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "nested.txt"), "sub\ncommitted\n");
    git(subDir, "add", "nested.txt");
    git(subDir, "-c", "commit.gpgsign=false", "commit", "-m", "sub change");

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
      expandSubmodules: true,
    });

    expect(result.diff).not.toContain("Subproject commit");
    const nested = result.structured?.find((file) => file.path === "libs/sub/nested.txt");
    expect(nested).toBeDefined();
    expect(nested?.hunks.flatMap((hunk) => hunk.lines)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "add", content: "committed" })]),
    );
  });

  it("keeps the gitlink stub when expansion is enabled but the submodule is missing", async () => {
    const repoDir = initRepo();
    const subDir = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "nested.txt"), "sub\ncommitted\n");
    git(subDir, "add", "nested.txt");
    git(subDir, "-c", "commit.gpgsign=false", "commit", "-m", "sub change");
    rmSync(subDir, { recursive: true, force: true });

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
      expandSubmodules: true,
    });

    expect(result.diff).toMatch(/Subproject commit/i);
    expect(result.structured?.some((file) => file.path === "libs/sub")).toBe(true);
    expect(result.structured?.some((file) => file.path === "libs/sub/nested.txt")).toBeFalsy();
  });
});
