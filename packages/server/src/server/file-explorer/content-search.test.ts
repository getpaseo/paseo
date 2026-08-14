import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { searchFileContents, parseGitGrepLine, ContentSearchQueryError } from "./content-search";

let tempRoot: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "paseo-search-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("parseGitGrepLine", () => {
  it("parses path, line number, and text", () => {
    expect(parseGitGrepLine("src/a.ts:12:hello: world")).toEqual({
      relPath: "src/a.ts",
      match: { line: 12, text: "hello: world" },
    });
  });

  it("handles file names containing colons", () => {
    expect(parseGitGrepLine("we:ird/name.ts:42:some: text")).toEqual({
      relPath: "we:ird/name.ts",
      match: { line: 42, text: "some: text" },
    });
  });

  it("returns null for non-matching lines", () => {
    expect(parseGitGrepLine("not a grep line")).toBeNull();
  });
});

describe("searchFileContents", () => {
  it("rejects queries shorter than 2 characters", async () => {
    await expect(searchFileContents(tempRoot, "a")).rejects.toBeInstanceOf(ContentSearchQueryError);
  });

  it("finds matches in a git repo with line numbers", async () => {
    git(tempRoot, "init", "-b", "main");
    mkdirSync(join(tempRoot, "src"));
    writeFileSync(join(tempRoot, "src", "a.ts"), "one\ntwo needle here\nthree\n");
    writeFileSync(join(tempRoot, "b.txt"), "NEEDLE uppercase\nno match\n");
    git(tempRoot, "add", ".");
    execFileSync(
      "git",
      ["-C", tempRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { stdio: "pipe" },
    );

    const result = await searchFileContents(tempRoot, "needle");

    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(2);
    const a = result.files.find((f) => f.relPath === "src/a.ts");
    const b = result.files.find((f) => f.relPath === "b.txt");
    expect(a?.matches).toEqual([{ line: 2, text: "two needle here" }]);
    expect(b?.matches).toEqual([{ line: 1, text: "NEEDLE uppercase" }]);
  });

  it("includes untracked files (git grep --untracked)", async () => {
    git(tempRoot, "init", "-b", "main");
    writeFileSync(join(tempRoot, "untracked.txt"), "fresh needle\n");
    git(tempRoot, "add", ".");

    const result = await searchFileContents(tempRoot, "needle");

    expect(result.files.map((f) => f.relPath)).toEqual(["untracked.txt"]);
  });

  it("falls back to the walk for non-git directories", async () => {
    mkdirSync(join(tempRoot, "sub"));
    writeFileSync(join(tempRoot, "sub", "c.md"), "plain needle line\n");

    const result = await searchFileContents(tempRoot, "needle");

    expect(result.files).toHaveLength(1);
    expect(result.files[0].relPath).toBe("sub/c.md");
    expect(result.files[0].matches[0].line).toBe(1);
  });

  it("skips ignored directories in the walk fallback", async () => {
    mkdirSync(join(tempRoot, "node_modules"), { recursive: true });
    writeFileSync(join(tempRoot, "node_modules", "dep.js"), "needle in dependency");
    mkdirSync(join(tempRoot, "keep"));
    writeFileSync(join(tempRoot, "keep", "k.js"), "needle kept");

    const result = await searchFileContents(tempRoot, "needle");

    expect(result.files.map((f) => f.relPath)).toEqual(["keep/k.js"]);
  });

  it("skips binary files (NUL byte) in the walk fallback", async () => {
    writeFileSync(
      join(tempRoot, "blob.bin"),
      Buffer.from([0x61, 0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
    );

    const result = await searchFileContents(tempRoot, "needle");

    expect(result.files).toHaveLength(0);
  });
});
