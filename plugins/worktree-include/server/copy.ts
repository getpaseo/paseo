// Derived from cprecioso/paseo-worktreeinclude (MIT); see ./LICENSE in the plugin root.
// Copyright (c) 2026 Carlos Precioso.
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const INCLUDE_FILE = ".worktreeinclude";

export type CopyResult =
  | { kind: "no-include-file" }
  | { kind: "copied"; copied: string[]; skipped: string[] };

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const child = exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  const { stdout } = await child;
  return stdout;
}

async function gitAllowExit1(cwd: string, args: string[], input: string): Promise<string> {
  try {
    return await git(cwd, args, input);
  } catch (error) {
    // `git check-ignore` exits 1 when nothing matched.
    if ((error as { code?: number }).code === 1) return "";
    throw error;
  }
}

const splitNul = (s: string) => s.split("\0").filter(Boolean);
const isDirectory = (entry: string) => entry.endsWith("/");

// Copy files that match .worktreeinclude (gitignore syntax)
// AND are gitignored, so tracked files are never touched.
export async function copyWorktreeIncludes(worktree: string, source: string): Promise<CopyResult> {
  if (!existsSync(join(source, INCLUDE_FILE))) return { kind: "no-include-file" };

  const matches = await findIncludedFiles(source);
  if (matches.length === 0) return { kind: "copied", copied: [], skipped: [] };

  const ignored = splitNul(
    await gitAllowExit1(source, ["check-ignore", "--stdin", "-z"], matches.join("\0") + "\0"),
  );

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const file of ignored) {
    const dest = join(worktree, file);
    if (existsSync(dest)) {
      skipped.push(file);
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    // Clone (APFS/btrfs copy-on-write) when supported, else fall back to a regular copy.
    await copyFile(join(source, file), dest, constants.COPYFILE_FICLONE);
    copied.push(file);
  }
  return { kind: "copied", copied, skipped };
}

// Git lists a directory it ignores as a whole, such as node_modules/, as one entry.
// Only directories that a pattern matches or names a path inside are searched, so
// creating a worktree does not walk every file in large ignored trees.
async function findIncludedFiles(source: string): Promise<string[]> {
  const ignored = splitNul(
    await git(source, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]),
  );
  if (ignored.length === 0) return [];

  const patterns = parsePatterns(await readFile(join(source, INCLUDE_FILE), "utf8"));
  const matched = await matchIncludePatterns(source, ignored);
  const files = ignored.filter((entry) => !isDirectory(entry) && matched(entry));
  const searched = ignored.filter(
    (entry) =>
      isDirectory(entry) && (matched(entry) || patterns.some((p) => reachesInside(p, entry))),
  );
  if (searched.length === 0) return files;

  const inside = splitNul(
    await git(source, [
      "ls-files",
      "--others",
      "--ignored",
      `--exclude-from=${INCLUDE_FILE}`,
      "-z",
      "--",
      ...searched.map((directory) => `:(literal)${directory}`),
    ]),
  );
  return [...files, ...inside];
}

// Match entries against .worktreeinclude alone by recreating them, empty, in a scratch
// repository where no other ignore rules apply.
async function matchIncludePatterns(
  source: string,
  entries: string[],
): Promise<(entry: string) => boolean> {
  const scratch = await mkdtemp(join(tmpdir(), "paseo-worktree-include-"));
  try {
    await git(scratch, ["init", "-q"]);
    for (const entry of entries) {
      if (isDirectory(entry)) {
        await mkdir(join(scratch, entry), { recursive: true });
      } else {
        await mkdir(dirname(join(scratch, entry)), { recursive: true });
        await writeFile(join(scratch, entry), "");
      }
    }
    const matched = splitNul(
      await git(scratch, [
        "ls-files",
        "--others",
        "--ignored",
        `--exclude-from=${join(source, INCLUDE_FILE)}`,
        "--directory",
        "-z",
      ]),
    );
    return (entry) =>
      matched.some((match) => match === entry || (isDirectory(match) && entry.startsWith(match)));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function parsePatterns(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
}

// A pattern with a slash before its end is anchored to the checkout root, so it can
// name a path inside `directory` when its literal start and the directory overlap.
function reachesInside(pattern: string, directory: string): boolean {
  const path = pattern.replace(/^\//, "");
  if (!path.replace(/\/$/, "").includes("/")) return false;
  const literal = path.slice(0, path.search(/[*?[\\]|$/));
  return literal.startsWith(directory) || directory.startsWith(literal);
}
