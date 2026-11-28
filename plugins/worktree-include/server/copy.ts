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

// `core.fsmonitor=false` prevents repository config from launching a command.
// `safe.bareRepository=explicit` stops git from adopting a directory that only
// looks like a bare repository.
const GIT_CONFIG_ARGS = ["-c", "core.fsmonitor=false", "-c", "safe.bareRepository=explicit"];

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const child = exec("git", [...GIT_CONFIG_ARGS, ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  const { stdout } = await child;
  return stdout;
}

// `git check-ignore --stdin` reads each path as a pathspec, so a name such as `:(x`
// would be parsed as pathspec magic. A `./` prefix keeps every path literal.
async function checkIgnore(cwd: string, args: string[], paths: string[]): Promise<string[]> {
  const input = paths.map((path) => `./${path}\0`).join("");
  let output: string;
  try {
    output = await git(cwd, [...args, "check-ignore", "--stdin", "-z"], input);
  } catch (error) {
    // `git check-ignore` exits 1 when nothing matched.
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
  return splitNul(output).map((path) => path.replace(/^\.\//, ""));
}

const splitNul = (s: string) => s.split("\0").filter(Boolean);
const isDirectory = (entry: string) => entry.endsWith("/");

// Copy files that match .worktreeinclude (gitignore syntax)
// AND are gitignored, so tracked files are never touched.
export async function copyWorktreeIncludes(worktree: string, source: string): Promise<CopyResult> {
  if (!existsSync(join(source, INCLUDE_FILE))) return { kind: "no-include-file" };

  const matches = await findIncludedFiles(source);
  if (matches.length === 0) return { kind: "copied", copied: [], skipped: [] };

  const ignored = await checkIgnore(source, [], matches);

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

  const ignoreCase = await sourceIgnoresCase(source);
  const patterns = parsePatterns(await readFile(join(source, INCLUDE_FILE), "utf8"));
  const matched = new Set(await matchIncludePatterns(source, ignored, ignoreCase));
  const files = ignored.filter((entry) => !isDirectory(entry) && matched.has(entry));
  const searched = new Set<string>();
  // Git also lists an untracked folder that holds ignored entries, which are listed on
  // their own, so only folders Git ignores as a whole are searched.
  const directories = await checkIgnore(source, [], ignored.filter(isDirectory));
  for (const directory of directories) {
    if (matched.has(directory)) {
      searched.add(directory);
      continue;
    }
    for (const pattern of patterns) {
      const inside = searchedPathInside(pattern, directory, ignoreCase);
      if (inside !== null) searched.add(inside);
    }
  }
  if (searched.size === 0) return files;

  const pathspecs = [...searched].map(
    (path) => `:(${ignoreCase ? "literal,icase" : "literal"})${path}`,
  );
  const inside: string[] = [];
  for (const batch of commandLineBatches(pathspecs)) {
    const listed = await git(source, [
      "ls-files",
      "--others",
      "--ignored",
      `--exclude-from=${INCLUDE_FILE}`,
      "-z",
      "--",
      ...batch,
    ]);
    inside.push(...splitNul(listed));
  }
  return [...new Set([...files, ...inside])];
}

// Windows caps a command line at 32,767 characters, so a pattern such as `**/.env` in a
// repo with many ignored folders searches them over several Git calls.
const COMMAND_LINE_BATCH_CHARS = 16_000;

function commandLineBatches(args: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const arg of args) {
    if (batch.length > 0 && length + arg.length + 1 > COMMAND_LINE_BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(arg);
    length += arg.length + 1;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// Match entries against .worktreeinclude alone, in a scratch repository where no other
// ignore rules apply. Directory entries keep their trailing slash, so directory
// patterns match them without anything on disk.
async function matchIncludePatterns(
  source: string,
  entries: string[],
  ignoreCase: boolean,
): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), "paseo-worktree-include-"));
  try {
    // An empty template keeps the user's template `info/exclude` out of the matching.
    await git(scratch, ["init", "-q", "--template="]);
    return await checkIgnore(
      scratch,
      [
        "-c",
        `core.excludesFile=${join(source, INCLUDE_FILE)}`,
        "-c",
        `core.ignoreCase=${ignoreCase}`,
      ],
      entries,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// The scratch repository would otherwise take core.ignoreCase from the temp folder.
async function sourceIgnoresCase(source: string): Promise<boolean> {
  try {
    return (await git(source, ["config", "--type=bool", "core.ignoreCase"])).trim() === "true";
  } catch {
    // `git config` exits 1 when the key is unset.
    return false;
  }
}

function parsePatterns(contents: string): string[] {
  // Git skips a leading UTF-8 byte order mark in exclude files.
  return contents
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
}

// A pattern with a slash before its end is anchored to the checkout root, so it can
// name a path inside `directory` when its literal start and the directory overlap.
// Without `**`, a pattern matches paths of exactly its own depth, so a directory that
// deep or deeper can hold no match below it. Returns the narrowest path to search: the
// whole path when the pattern has no glob, else the folder before its first glob, or
// `directory` itself when the path ends above it.
function searchedPathInside(
  pattern: string,
  rawDirectory: string,
  ignoreCase: boolean,
): string | null {
  // Git folds only ASCII letters when it ignores case.
  const fold = (text: string) =>
    ignoreCase ? text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()) : text;
  const path = fold(pattern.replace(/^\//, ""));
  const directory = fold(rawDirectory);
  const depth = (text: string) => text.replace(/\/$/, "").split("/").length;
  if (depth(path) < 2) return null;
  if (!path.includes("**") && depth(directory) >= depth(path)) return null;
  const globAt = path.search(/[*?[\\]/);
  const literal = globAt === -1 ? path : path.slice(0, globAt);
  if (!literal.startsWith(directory) && !directory.startsWith(literal)) return null;
  const searched = globAt === -1 ? literal : literal.slice(0, literal.lastIndexOf("/") + 1);
  return searched.length > directory.length ? searched : directory;
}
