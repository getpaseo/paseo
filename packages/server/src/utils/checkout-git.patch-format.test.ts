import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCheckoutDiff, getCommitFileDiff } from "./checkout-git.js";

const repos: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

it.each(["diff.mnemonicPrefix=true", "color.diff=always", "diff.noprefix=true"])(
  "preserves batched paths, spaces and literal prefix directories with %s",
  async (config) => {
    const cwd = createChangedRepo(config);
    mkdirSync(join(cwd, "a"));
    for (const name of ["a/literal.txt", "with spaces.txt"]) {
      writeFileSync(join(cwd, name), "before\n");
    }
    git(cwd, "add", "a/literal.txt", "with spaces.txt");
    git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "add files");
    for (const name of ["a/literal.txt", "with spaces.txt"]) {
      writeFileSync(join(cwd, name), "after\n");
    }

    const result = await getCheckoutDiff(cwd, { mode: "uncommitted", includeStructured: true });

    expect(result.structured?.map((file) => file.path)).toEqual([
      "a/literal.txt",
      "file.txt",
      "with spaces.txt",
    ]);
    for (const file of result.structured ?? []) {
      expect(file.hunks.flatMap((hunk) => hunk.lines)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "remove", content: "before" }),
          expect.objectContaining({ type: "add", content: "after" }),
        ]),
      );
    }
    expect(git(cwd, "config", "--get", config.split("=")[0]).trim()).toBe(config.split("=")[1]);
  },
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createChangedRepo(config: string): string {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-patch-format-")));
  repos.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "file.txt"), "before\n");
  git(cwd, "add", ".");
  git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
  git(cwd, "config", ...config.split("="));
  writeFileSync(join(cwd, "file.txt"), "after\n");
  return cwd;
}

function createExternalDiffCommand() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-external-diff-")));
  repos.push(directory);
  const script = join(directory, "external-diff.cjs");
  const marker = join(directory, "invoked");
  writeFileSync(
    script,
    'require("node:fs").writeFileSync(process.argv[2], "invoked");\n' +
      'process.stdout.write("CUSTOM EXTERNAL DIFF\\n");\n',
  );
  const command = [process.execPath, script, marker]
    .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
    .join(" ");
  return { command, marker };
}

function createExternalDiffRepo() {
  vi.stubEnv("GIT_EXTERNAL_DIFF", undefined);
  const cwd = createChangedRepo("color.diff=always");
  const { command, marker } = createExternalDiffCommand();
  git(cwd, "config", "diff.external", command);
  expect(git(cwd, "diff", "HEAD", "--", "file.txt")).toBe("CUSTOM EXTERNAL DIFF\n");
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  return { cwd, command, marker };
}

function expectStandardPatch(result: Awaited<ReturnType<typeof getCheckoutDiff>>) {
  expect(result.structured).toMatchObject([
    {
      path: "file.txt",
      additions: 1,
      deletions: 1,
      status: "ok",
      hunks: [
        {
          lines: [
            { type: "header", content: "@@ -1 +1 @@" },
            { type: "remove", content: "before" },
            { type: "add", content: "after" },
          ],
        },
      ],
    },
  ]);
}

it("returns Git patch hunks when a repository configures an external diff command", async () => {
  const { cwd, command, marker } = createExternalDiffRepo();

  const result = await getCheckoutDiff(cwd, { mode: "uncommitted", includeStructured: true });

  expectStandardPatch(result);
  expect(existsSync(marker)).toBe(false);
  expect(git(cwd, "config", "--get", "diff.external").trim()).toBe(command);
});

it("returns Git patch hunks against the base branch with an external diff command", async () => {
  const { cwd, command, marker } = createExternalDiffRepo();
  git(cwd, "checkout", "-b", "feature");
  git(cwd, "add", ".");
  git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "edit");

  const result = await getCheckoutDiff(cwd, {
    mode: "base",
    baseRef: "main",
    includeStructured: true,
  });

  expectStandardPatch(result);
  expect(existsSync(marker)).toBe(false);
  expect(git(cwd, "config", "--get", "diff.external").trim()).toBe(command);
});

it("returns Git patch hunks when GIT_EXTERNAL_DIFF configures the external command", async () => {
  const cwd = createChangedRepo("color.diff=always");
  const { command, marker } = createExternalDiffCommand();
  vi.stubEnv("GIT_EXTERNAL_DIFF", command);
  expect(git(cwd, "diff", "HEAD", "--", "file.txt")).toBe("CUSTOM EXTERNAL DIFF\n");
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);

  const result = await getCheckoutDiff(cwd, { mode: "uncommitted", includeStructured: true });

  expectStandardPatch(result);
  expect(existsSync(marker)).toBe(false);
  expect(process.env.GIT_EXTERNAL_DIFF).toBe(command);
});

describe.each(["diff.mnemonicPrefix=true", "color.diff=always"])(
  "patch format with %s",
  (config) => {
    it("returns displayable uncommitted diff lines with their file counts", async () => {
      const cwd = createChangedRepo(config);
      const result = await getCheckoutDiff(cwd, { mode: "uncommitted", includeStructured: true });

      expect(result.structured).toHaveLength(1);
      expect(result.structured?.[0]).toMatchObject({
        path: "file.txt",
        additions: 1,
        deletions: 1,
      });
      expect(result.structured?.[0].hunks.flatMap((hunk) => hunk.lines)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "remove", content: "before" }),
          expect.objectContaining({ type: "add", content: "after" }),
        ]),
      );
    });

    it("returns displayable committed changes against the base branch", async () => {
      const cwd = createChangedRepo(config);
      git(cwd, "checkout", "-b", "feature");
      git(cwd, "add", ".");
      git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "edit");
      const result = await getCheckoutDiff(cwd, {
        mode: "base",
        baseRef: "main",
        includeStructured: true,
      });

      expect(result.structured?.[0]).toMatchObject({
        path: "file.txt",
        additions: 1,
        deletions: 1,
      });
      expect(result.structured?.[0].hunks.flatMap((hunk) => hunk.lines)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "add", content: "after" })]),
      );
    });

    it("returns displayable lines when opening an individual commit file", async () => {
      const cwd = createChangedRepo(config);
      git(cwd, "add", ".");
      git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "edit");
      const file = await getCommitFileDiff({
        cwd,
        sha: git(cwd, "rev-parse", "HEAD").trim(),
        path: "file.txt",
      });

      expect(file).toMatchObject({ path: "file.txt", additions: 1, deletions: 1 });
      expect(file?.hunks.flatMap((hunk) => hunk.lines)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "add", content: "after" })]),
      );
    });
  },
);
