import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// Total directories Git visits while listing files, read from its trace2 events.
async function directoriesVisited(run: () => Promise<unknown>): Promise<number> {
  const trace = join(root, "trace.json");
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    await run();
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
  }
  return (await readFile(trace, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; key?: string; value?: string })
    .filter((event) => event.event === "data" && event.key === "directories-visited")
    .reduce((total, event) => total + Number(event.value), 0);
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
  it("does not run a command the source repository configures as its fsmonitor", async () => {
    const marker = join(root, "fsmonitor.marker");
    const hook = join(root, "fsmonitor-hook.sh");
    await writeFile(hook, `#!/bin/sh\n: > '${marker}'\nprintf '1\\n'\n`);
    await chmod(hook, 0o755);
    await writeSource({ ".gitignore": ".env\n", ".worktreeinclude": ".env\n", ".env": "A=1" });
    execFileSync("git", ["add", ".gitignore", ".worktreeinclude"], { cwd: source });
    execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: source });

    expect(await copied()).toEqual([".env"]);
    expect(existsSync(marker)).toBe(false);
  });

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

  it("copies a file in an untracked directory once when a **/ pattern also searches it", async () => {
    await writeSource({
      ".gitignore": ".env\n",
      ".worktreeinclude": "**/.env\nnew-package/.env\n",
      "new-package/.env": "SECRET=new",
    });

    const result = await copyWorktreeIncludes(worktree, source);
    expect(result).toEqual({
      kind: "copied",
      copied: ["new-package/.env"],
      skipped: [],
    });
  });

  it("copies a path a pattern names inside an ignored directory", async () => {
    await writeSource({
      ".gitignore": "node_modules/\n",
      ".worktreeinclude": "node_modules/pkg/.env\n",
      "node_modules/pkg/.env": "SECRET=package",
      "node_modules/other/.env": "SECRET=other",
    });

    expect(await copied()).toEqual(["node_modules/pkg/.env"]);
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

  it("searches only the path a glob-free pattern names directly inside an ignored directory", async () => {
    const packages: Record<string, string> = {};
    for (let i = 0; i < 20; i++) packages[`node_modules/pkg${i}/lib/index.js`] = "code";
    await writeSource({
      ".gitignore": "node_modules/\n",
      ".worktreeinclude": "node_modules/.cache\n",
      "node_modules/.cache/state.json": "cache",
      ...packages,
    });

    let result: Awaited<ReturnType<typeof copyWorktreeIncludes>> | undefined;
    const visited = await directoriesVisited(async () => {
      result = await copyWorktreeIncludes(worktree, source);
    });

    expect(result).toEqual({
      kind: "copied",
      copied: ["node_modules/.cache/state.json"],
      skipped: [],
    });
    expect(visited).toBeLessThan(10);
  });

  it.skipIf(process.platform === "win32")(
    "copies includes when an ignored file is named like a Git pathspec",
    async () => {
      await writeSource({
        ".gitignore": "*.log\n.env\n",
        ".worktreeinclude": ".env\n",
        ".env": "SECRET=root",
        ":(oops.log": "log",
        ":!c.log": "log",
      });

      expect(await copied()).toEqual([".env"]);
    },
  );

  it("ignores exclude patterns from the user's git template", async () => {
    const template = join(root, "template");
    await mkdir(join(template, "info"), { recursive: true });
    await writeFile(join(template, "info", "exclude"), "*.log\n");
    await writeSource({
      ".gitignore": "*.log\n.env\n",
      ".worktreeinclude": ".env\n",
      ".env": "SECRET=root",
      "debug.log": "log",
    });

    process.env.GIT_TEMPLATE_DIR = template;
    try {
      expect(await copied()).toEqual([".env"]);
    } finally {
      delete process.env.GIT_TEMPLATE_DIR;
    }
  });

  it("does not search an ignored directory deeper than a pattern without ** can reach", async () => {
    const packages: Record<string, string> = {};
    for (let i = 0; i < 20; i++) packages[`apps/web/node_modules/pkg${i}/lib/index.js`] = "code";
    await writeSource({
      ".gitignore": "node_modules/\n.env\n",
      ".worktreeinclude": "apps/*/.env\n",
      "apps/web/.env": "SECRET=web",
      ...packages,
    });

    let result: Awaited<ReturnType<typeof copyWorktreeIncludes>> | undefined;
    const visited = await directoriesVisited(async () => {
      result = await copyWorktreeIncludes(worktree, source);
    });

    expect(result).toEqual({ kind: "copied", copied: ["apps/web/.env"], skipped: [] });
    expect(visited).toBeLessThan(10);
  });

  it("reads the first pattern after a UTF-8 byte order mark", async () => {
    await writeSource({
      ".gitignore": "node_modules/\n",
      ".worktreeinclude": "\uFEFFnode_modules/.cache/\n",
      "node_modules/.cache/state.json": "cache",
    });

    expect(await copied()).toEqual(["node_modules/.cache/state.json"]);
  });

  it("matches patterns case-insensitively when the source repo ignores case", async () => {
    execFileSync("git", ["-C", source, "config", "core.ignoreCase", "true"]);
    await writeSource({
      ".gitignore": ".env\nconfig/\n",
      ".worktreeinclude": ".ENV\nCONFIG/a.json\n",
      ".env": "SECRET=root",
      "config/a.json": "a",
    });

    expect(await copied()).toEqual([".env", "config/a.json"]);
  });

  it("searches a pattern's path in the case it has on disk when the source repo ignores case", async () => {
    execFileSync("git", ["-C", source, "config", "core.ignoreCase", "true"]);
    await writeSource({
      ".gitignore": "Config/\nÉTÉ/\n",
      ".worktreeinclude": "config/a.json\nÉTÉ/sub/.env\n",
      "Config/a.json": "a",
      "ÉTÉ/sub/.env": "SECRET=summer",
    });

    expect(await copied()).toEqual(["Config/a.json", "ÉTÉ/sub/.env"]);
  });

  // Each searched folder is one argument to Git. Windows caps a command line at 32,767
  // characters and Linux at 2 MB, so each platform gets enough folders to exceed its own
  // limit, with names short enough for Windows paths.
  it("searches more ignored folders than fit on one command line", async () => {
    const folders = process.platform === "win32" ? 300 : 15_000;
    const name = (i: number) => `${"x".repeat(150)}${i}`;
    await writeSource({
      ".gitignore": "x*/\n.env\n",
      ".worktreeinclude": "**/.env\n",
      [`${name(folders - 1)}/.env`]: "SECRET=last",
    });
    for (let i = 0; i < folders - 1; i++) await mkdir(join(source, name(i)));
    await Promise.all(
      Array.from({ length: folders - 1 }, (_, i) => writeFile(join(source, name(i), "a"), "")),
    );

    expect(await copied()).toEqual([`${name(folders - 1)}/.env`]);
  }, 60_000);

  it("copies ignored files inside an untracked directory a pattern names", async () => {
    await writeSource({
      ".gitignore": ".env\n",
      ".worktreeinclude": "newdir/\n",
      "newdir/.env": "SECRET=new",
      "newdir/notes.txt": "untracked",
    });

    expect(await copied()).toEqual(["newdir/.env"]);
  });
});
