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

function addNestedSubmodule(repoDir: string, subPath = "libs/sub"): { subDir: string; sha: string } {
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
  return { subDir, sha };
}

describe("getCheckoutDiff submodule stubs", () => {
  it("emits a dirty submodule as an isSubmodule stub with metadata", async () => {
    const repoDir = initRepo();
    const { subDir, sha } = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "nested.txt"), "sub\nchanged\n");

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    const stub = result.structured?.find((file) => file.path === "libs/sub");
    expect(stub).toMatchObject({
      path: "libs/sub",
      isSubmodule: true,
      hunks: [],
      submodule: {
        oldCommit: sha,
        newCommit: sha,
        isDirty: true,
      },
    });
    expect(result.structured?.some((file) => file.path === "libs/sub/nested.txt")).toBeFalsy();
  });

  it("records old/new commits for submodule pointer moves", async () => {
    const repoDir = initRepo();
    const { subDir, sha: oldSha } = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "nested.txt"), "sub\ncommitted\n");
    git(subDir, "add", "nested.txt");
    git(subDir, "-c", "commit.gpgsign=false", "commit", "-m", "sub change");
    const newSha = git(subDir, "rev-parse", "HEAD");

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    const stub = result.structured?.find((file) => file.path === "libs/sub");
    expect(stub?.isSubmodule).toBe(true);
    expect(stub?.submodule?.oldCommit).toBe(oldSha);
    expect(stub?.submodule?.newCommit).toBe(newSha);
    expect(stub?.hunks).toEqual([]);
    expect(result.structured?.some((file) => file.path === "libs/sub/nested.txt")).toBeFalsy();
  });

  it("still yields a stub when the submodule checkout is missing", async () => {
    const repoDir = initRepo();
    const { subDir, sha: oldSha } = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "nested.txt"), "sub\ncommitted\n");
    git(subDir, "add", "nested.txt");
    git(subDir, "-c", "commit.gpgsign=false", "commit", "-m", "sub change");
    const newSha = git(subDir, "rev-parse", "HEAD");
    git(repoDir, "update-index", "--cacheinfo", `160000,${newSha},libs/sub`);
    rmSync(subDir, { recursive: true, force: true });

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    const stub = result.structured?.find((file) => file.path === "libs/sub");
    expect(stub).toBeDefined();
    expect(stub?.isSubmodule).toBe(true);
    expect(stub?.submodule?.oldCommit).toBe(oldSha);
    expect(stub?.submodule?.newCommit).toBe(newSha);
    expect(result.structured?.some((file) => file.path.startsWith("libs/sub/"))).toBeFalsy();
  });

  it("does not flatten nested submodule file paths into the parent structured list", async () => {
    const repoDir = initRepo();
    const { subDir } = addNestedSubmodule(repoDir);
    writeFileSync(join(subDir, "nested.txt"), "sub\nchanged\n");
    writeFileSync(join(subDir, "extra.txt"), "untracked\n");

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(result.structured?.some((file) => file.path === "libs/sub")).toBe(true);
    expect(result.structured?.some((file) => file.path === "libs/sub/nested.txt")).toBe(false);
    expect(result.structured?.some((file) => file.path === "libs/sub/extra.txt")).toBe(false);
  });
});
