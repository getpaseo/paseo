import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { searchWorkspaceFiles, type SearchCommandRunner } from "./service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

describe("searchWorkspaceFiles", () => {
  test("groups ripgrep matches with navigable positions and search options", async () => {
    const cwd = makeDir("paseo-file-search-");
    writeFileSync(join(cwd, "included.ts"), "Needle needle needles\nneedle\n");
    writeFileSync(join(cwd, "excluded.test.ts"), "needle\n");

    const result = await searchWorkspaceFiles({
      cwd,
      query: "needle",
      caseSensitive: true,
      wholeWord: true,
      useRegex: false,
      includePattern: "*.ts",
      excludePattern: "*.test.ts",
      maxResults: 20,
    });

    expect(result).toEqual({
      files: [
        {
          path: "included.ts",
          matches: [
            { line: 1, column: 8, matchLength: 6, lineContent: "Needle needle needles" },
            { line: 2, column: 1, matchLength: 6, lineContent: "needle" },
          ],
        },
      ],
      totalMatches: 2,
      truncated: false,
    });
  });

  test("caps matches, bounds line content, and does not follow links outside the workspace", async () => {
    const cwd = makeDir("paseo-file-search-bounds-");
    const outside = makeDir("paseo-file-search-outside-");
    writeFileSync(join(outside, "secret.txt"), "needle\n");
    symlinkSync(outside, join(cwd, "outside-link"));
    writeFileSync(join(cwd, "long.txt"), `${"x".repeat(700)}needle${"y".repeat(700)}\nneedle\n`);

    const result = await searchWorkspaceFiles({
      cwd,
      query: "needle",
      maxResults: 1,
    });

    expect(result.totalMatches).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("long.txt");
    expect(result.files[0]?.matches[0]).toMatchObject({
      line: 1,
      column: 701,
      matchLength: 6,
      lineContentStartColumn: expect.any(Number),
    });
    expect(result.files[0]?.matches[0]?.lineContent.length).toBeLessThanOrEqual(500);
    expect(result.files.some((file) => file.path.includes("secret"))).toBe(false);
  });

  test("aborts the search command at the daemon timeout", async () => {
    const runner: SearchCommandRunner = {
      async run(command) {
        return new Promise((resolve) => {
          command.signal.addEventListener("abort", () => resolve({ exitCode: null, stderr: "" }), {
            once: true,
          });
        });
      },
    };
    const cwd = makeDir("paseo-file-search-timeout-");

    await expect(
      searchWorkspaceFiles({ cwd, query: "needle" }, { runner, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "timeout", message: "Search timed out" });
  });

  test("rejects a relative workspace root", async () => {
    await expect(searchWorkspaceFiles({ cwd: ".", query: "needle" })).rejects.toMatchObject({
      code: "invalid_workspace",
    });
  });

  test("ignores a partial ripgrep JSON record left by subprocess cancellation", async () => {
    const runner: SearchCommandRunner = {
      async run(command) {
        command.onStdoutLine('{"type":"match","data":{"path":{"text":"notes.txt"}');
        return { exitCode: 0, stderr: "" };
      },
    };
    const cwd = makeDir("paseo-file-search-partial-json-");

    await expect(searchWorkspaceFiles({ cwd, query: "needle" }, { runner })).resolves.toEqual({
      files: [],
      totalMatches: 0,
      truncated: false,
    });
  });

  test("falls back to git grep when ripgrep is unavailable", async () => {
    const calls: string[] = [];
    const runner: SearchCommandRunner = {
      async run(command) {
        calls.push(command.command);
        if (command.command === "rg") {
          const error = new Error("rg missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        command.onStdoutLine("src/search.ts\u000012\u00005\u0000const needle = needle;");
        return { exitCode: 0, stderr: "" };
      },
    };

    const cwd = makeDir("paseo-file-search-git-");
    const result = await searchWorkspaceFiles({ cwd, query: "needle", maxResults: 20 }, { runner });

    expect(calls).toEqual(["rg", "git"]);
    expect(result).toEqual({
      files: [
        {
          path: "src/search.ts",
          matches: [
            { line: 12, column: 7, matchLength: 6, lineContent: "const needle = needle;" },
            { line: 12, column: 16, matchLength: 6, lineContent: "const needle = needle;" },
          ],
        },
      ],
      totalMatches: 2,
      truncated: false,
    });
  });
});
