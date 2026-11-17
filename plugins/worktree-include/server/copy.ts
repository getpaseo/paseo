// Derived from cprecioso/paseo-worktreeinclude (MIT); see ./LICENSE in the plugin root.
// Copyright (c) 2026 Carlos Precioso.
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
// Only directories that a pattern matches or names a path inside are searched, and
// only as deep as the pattern names, so creating a worktree does not walk every file
// in large ignored trees.
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
  const matched = new Set(await matchIncludePatterns(source, ignored));
  const files = ignored.filter((entry) => !isDirectory(entry) && matched.has(entry));
  const searched = new Set<string>();
  for (const directory of ignored.filter(isDirectory)) {
    if (matched.has(directory)) {
      searched.add(directory);
      continue;
    }
    for (const pattern of patterns) {
      const inside = searchedPathInside(pattern, directory);
      if (inside !== null) searched.add(inside);
    }
  }
  if (searched.size === 0) return files;

  const inside = splitNul(
    await git(source, [
      "ls-files",
      "--others",
      "--ignored",
      `--exclude-from=${INCLUDE_FILE}`,
      "-z",
      "--",
      ...[...searched].map((path) => `:(literal)${path}`),
    ]),
  );
  return [...new Set([...files, ...inside])];
}

// Match entries against .worktreeinclude alone, in a scratch repository where no other
// ignore rules apply. Directory entries keep their trailing slash, so directory
// patterns match them without anything on disk.
async function matchIncludePatterns(source: string, entries: string[]): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), "paseo-worktree-include-"));
  try {
    await git(scratch, ["init", "-q"]);
    return splitNul(
      await gitAllowExit1(
        scratch,
        [
          "-c",
          `core.excludesFile=${join(source, INCLUDE_FILE)}`,
          "check-ignore",
          "--no-index",
          "--stdin",
          "-z",
        ],
        entries.join("\0") + "\0",
      ),
    );
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
// Returns the narrowest path to search: the folder the pattern names inside
// `directory`, or `directory` itself.
function searchedPathInside(pattern: string, directory: string): string | null {
  const path = pattern.replace(/^\//, "");
  if (!path.replace(/\/$/, "").includes("/")) return null;
  const literal = path.slice(0, path.search(/[*?[\\]|$/));
  if (!literal.startsWith(directory) && !directory.startsWith(literal)) return null;
  const literalFolder = literal.slice(0, literal.lastIndexOf("/") + 1);
  return literalFolder.length > directory.length ? literalFolder : directory;
}
