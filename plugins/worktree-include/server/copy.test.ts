import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyWorktreeIncludes } from "./copy.js";

let root: string;
let source: string;
let worktree: string;

async function writeSource(files: Record<string, string>): Promise<void> {
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await writeFile(join(source, file), contents);
  }
}

async function copied(): Promise<string[]> {
  const result = await copyWorktreeIncludes(worktree, source);
  if (result.kind !== "copied") throw new Error(`expected a copy, got ${result.kind}`);
  return [...result.copied].sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktree-include-"));
  source = join(root, "source");
  worktree = join(root, "worktree");
  await mkdir(source);
  await mkdir(worktree);
  execFileSync("git", ["init", "-q", source]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("copyWorktreeIncludes", () => {
  it("does not search inside an ignored directory that no pattern names", async () => {
    await writeSource({
      ".gitignore": "node_modules/\n.env\n",
      ".worktreeinclude": ".env\n",
      ".env": "SECRET=root",
      "apps/web/.env": "SECRET=web",
      "node_modules/pkg/.env": "SECRET=package",
    });

    expect(await copied()).toEqual([".env", "apps/web/.env"]);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("searches inside ignored directories for a pattern that starts with **/", async () => {
    await writeSource({
      ".gitignore": "node_modules/\n.env\n",
      ".worktreeinclude": "**/.env\n",
      ".env": "SECRET=root",
      "node_modules/pkg/.env": "SECRET=package",
    });

    expect(await copied()).toEqual([".env", "node_modules/pkg/.env"]);
  });

  it("copies an ignored directory that a pattern names", async () => {
    await writeSource({
      ".gitignore": ".secrets/\nbuild/\n",
      ".worktreeinclude": ".secrets/\n",
      ".secrets/a.key": "a",
      ".secrets/nested/b.key": "b",
      "build/out.js": "built",
    });

    expect(await copied()).toEqual([".secrets/a.key", ".secrets/nested/b.key"]);
  });

  it("searches inside an ignored directory for a path a pattern names", async () => {
    await writeSource({
      ".gitignore": "config/\n",
      ".worktreeinclude": "config/*.local.json\n!config/production.local.json\n",
      "config/dev.local.json": "dev",
      "config/production.local.json": "production",
      "config/defaults.json": "defaults",
    });

    expect(await copied()).toEqual(["config/dev.local.json"]);
    expect(await readFile(join(worktree, "config/dev.local.json"), "utf8")).toBe("dev");
  });

  it("copies ignored files inside an untracked directory", async () => {
    await writeSource({
      ".gitignore": ".env\n",
      ".worktreeinclude": ".env\n",
      "new-package/.env": "SECRET=new",
    });

    expect(await copied()).toEqual(["new-package/.env"]);
  });

  it("copies nothing that is tracked or not ignored", async () => {
    await writeSource({
      ".gitignore": ".env\n",
      ".worktreeinclude": ".env\nnotes.txt\n",
      "notes.txt": "not ignored",
    });

    expect(await copied()).toEqual([]);
  });
});
