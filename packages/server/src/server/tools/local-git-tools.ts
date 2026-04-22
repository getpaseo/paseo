/**
 * `git_status` and `git_diff` — structured views of the working tree
 * that agents can reason about without parsing free-form CLI output.
 *
 * We shell out to `git` instead of using a library (isomorphic-git etc.)
 * because every machine running the daemon already has git installed
 * (the daemon itself manages worktrees), and `git` is the source of
 * truth for edge cases like submodules, sparse checkouts, and line-
 * ending normalization.
 */

import { spawn } from "node:child_process";

export interface GitStatusInput {
  cwd: string;
}

export interface GitStatusEntry {
  /** Working-tree status code (porcelain v1): M, A, D, R, ?, etc. */
  worktree: string;
  /** Index status code. Same alphabet as `worktree`. */
  index: string;
  path: string;
  /** For renames/copies, the original path before the move. */
  originalPath?: string;
}

export interface GitStatusResult {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  clean: boolean;
}

export interface GitDiffInput {
  cwd: string;
  /** Include staged changes too. Default: unstaged only (matches `git diff`). */
  staged?: boolean;
  /** Limit diff to a specific path. */
  path?: string;
  /** Context lines around each hunk. Default 3 (git default). */
  contextLines?: number;
  /** Max bytes captured. Default 512 KiB. */
  maxBytes?: number;
}

export interface GitDiffResult {
  diff: string;
  truncated: boolean;
  bytes: number;
}

export interface GitLogInput {
  cwd: string;
  /** Limit the number of commits returned. Default 50. */
  maxCount?: number;
  /** Only commits touching this path. */
  path?: string;
  /** Commits by this author (substring match). */
  author?: string;
  /** e.g. "2 weeks ago", "2024-01-01". Passed to `--since`. */
  since?: string;
  /** Branch, tag, or commit to start from. Default: HEAD. */
  ref?: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string; // ISO 8601
  subject: string;
  body: string;
}

export interface GitLogResult {
  entries: GitLogEntry[];
}

export interface GitBlameInput {
  cwd: string;
  path: string;
  /** 1-based start line. Default: whole file. */
  startLine?: number;
  /** 1-based end line (inclusive). */
  endLine?: number;
}

export interface GitBlameLine {
  lineNumber: number;
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  content: string;
}

export interface GitBlameResult {
  path: string;
  lines: GitBlameLine[];
}

export interface GitBranchesInput {
  cwd: string;
  /** Include remote tracking branches (origin/main etc). Default false. */
  includeRemote?: boolean;
}

export interface GitBranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  /** Short hash of the branch tip, or null for unborn refs. */
  tipHash: string | null;
  /** Commit subject at the tip. */
  tipSubject: string | null;
}

export interface GitBranchesResult {
  branches: GitBranchEntry[];
}

export interface GitCheckoutInput {
  cwd: string;
  /** Branch name to switch to (or create, if `create: true`). */
  branch: string;
  /** Create a new branch. If it already exists and `create: true`, fails. */
  create?: boolean;
  /** When `create: true`, start point for the new branch (ref/sha). */
  startPoint?: string;
}

export interface GitCheckoutResult {
  branch: string;
  created: boolean;
  previous: string | null;
}

export interface GitStashInput {
  cwd: string;
  action: "list" | "save" | "pop" | "drop" | "apply";
  /** For `save`: a message. For `pop/drop/apply`: the stash ref (default `stash@{0}`). */
  message?: string;
  ref?: string;
  /** For `save`: include untracked files (`-u`). Default false. */
  includeUntracked?: boolean;
}

export interface GitStashEntry {
  ref: string;
  subject: string;
}

export interface GitStashResult {
  action: "list" | "save" | "pop" | "drop" | "apply";
  entries?: GitStashEntry[];
  /** Human-readable result of a non-list action (stdout line from git). */
  message?: string;
}

const DEFAULT_DIFF_MAX_BYTES = 512 * 1024;
const DEFAULT_LOG_COUNT = 50;

export async function gitStatus(input: GitStatusInput): Promise<GitStatusResult> {
  const raw = await runGit(
    input.cwd,
    ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
  );
  return parseGitStatus(raw);
}

/** Exported so tests can exercise parsing without spawning git. */
export function parseGitStatus(raw: string): GitStatusResult {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      // Shapes to handle:
      //   "main"
      //   "main...origin/main"
      //   "main...origin/main [ahead 2]"
      //   "main...origin/main [ahead 2, behind 1]"
      //   "HEAD (no branch)"
      //   "No commits yet on main"
      if (header.startsWith("No commits yet on ")) {
        branch = header.slice("No commits yet on ".length).trim();
        continue;
      }
      if (header === "HEAD (no branch)") {
        branch = null;
        continue;
      }
      const bracket = header.indexOf(" [");
      const core = bracket >= 0 ? header.slice(0, bracket) : header;
      const [localBranch, upstreamRef] = core.split("...");
      branch = localBranch ?? null;
      upstream = upstreamRef ?? null;
      if (bracket >= 0) {
        const tags = header.slice(bracket + 2, header.length - 1);
        for (const part of tags.split(",")) {
          const trimmed = part.trim();
          const [key, value] = trimmed.split(" ");
          if (key === "ahead") ahead = Number(value) || 0;
          if (key === "behind") behind = Number(value) || 0;
        }
      }
      continue;
    }

    // Status line: `XY path` or `XY orig -> path` for renames.
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const rest = line.slice(3);
    if (index === "R" || index === "C") {
      const [originalPath, newPath] = rest.split(" -> ");
      entries.push({
        index,
        worktree,
        path: newPath ?? rest,
        originalPath,
      });
    } else {
      entries.push({ index, worktree, path: rest });
    }
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    entries,
    clean: entries.length === 0,
  };
}

export async function gitDiff(input: GitDiffInput): Promise<GitDiffResult> {
  const maxBytes = input.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const args = ["diff", "--no-color"];
  if (input.staged) args.push("--staged");
  if (input.contextLines !== undefined) {
    args.push(`-U${input.contextLines}`);
  }
  if (input.path) {
    args.push("--", input.path);
  }
  const raw = await runGit(input.cwd, args, { maxBytes });
  const bytes = Buffer.byteLength(raw, "utf-8");
  const truncated = bytes >= maxBytes;
  return {
    diff: raw,
    truncated,
    bytes,
  };
}

/**
 * Format parses cleanly — fields are separated by ASCII unit-separators
 * (0x1F) and commits by record-separators (0x1E). These chars never
 * appear in commit messages in practice, so we can split safely without
 * worrying about newlines in the subject/body.
 */
const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";
const LOG_FORMAT = [
  "%H",
  "%h",
  "%an",
  "%ae",
  "%aI",
  "%s",
  "%b",
].join(LOG_FIELD_SEP);

export async function gitLog(input: GitLogInput): Promise<GitLogResult> {
  const maxCount = input.maxCount ?? DEFAULT_LOG_COUNT;
  const args = [
    "log",
    `-n${maxCount}`,
    `--pretty=format:${LOG_FORMAT}${LOG_RECORD_SEP}`,
  ];
  if (input.since) args.push(`--since=${input.since}`);
  if (input.author) args.push(`--author=${input.author}`);
  if (input.ref) args.push(input.ref);
  if (input.path) {
    args.push("--", input.path);
  }
  const raw = await runGit(input.cwd, args);
  const entries: GitLogEntry[] = [];
  for (const rec of raw.split(LOG_RECORD_SEP)) {
    const trimmed = rec.replace(/^\n/, "");
    if (!trimmed) continue;
    const parts = trimmed.split(LOG_FIELD_SEP);
    if (parts.length < 7) continue;
    entries.push({
      hash: parts[0]!,
      shortHash: parts[1]!,
      author: parts[2]!,
      authorEmail: parts[3]!,
      date: parts[4]!,
      subject: parts[5]!,
      body: parts[6]!.trim(),
    });
  }
  return { entries };
}

export async function gitBlame(input: GitBlameInput): Promise<GitBlameResult> {
  const args = ["blame", "--porcelain"];
  if (input.startLine !== undefined && input.endLine !== undefined) {
    args.push(`-L`, `${input.startLine},${input.endLine}`);
  } else if (input.startLine !== undefined) {
    args.push(`-L`, `${input.startLine},+1`);
  }
  args.push("--", input.path);
  const raw = await runGit(input.cwd, args);
  return {
    path: input.path,
    lines: parseBlamePorcelain(raw),
  };
}

/** Exported for unit tests — porcelain format is gnarly and worth its
 * own test matrix separate from the spawn-git integration. */
export function parseBlamePorcelain(raw: string): GitBlameLine[] {
  const lines: GitBlameLine[] = [];
  const commitCache = new Map<
    string,
    { author: string; date: string; shortHash: string }
  >();
  const rows = raw.split("\n");
  let i = 0;
  while (i < rows.length) {
    const header = rows[i];
    if (!header) {
      i++;
      continue;
    }
    // Header: "<40-char-sha> <origLine> <finalLine> [<count>]"
    const match = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(header);
    if (!match) {
      i++;
      continue;
    }
    const hash = match[1]!;
    const lineNumber = Number(match[2]);
    let author = commitCache.get(hash)?.author ?? "";
    let date = commitCache.get(hash)?.date ?? "";
    let shortHash = commitCache.get(hash)?.shortHash ?? hash.slice(0, 7);
    i++;
    // Metadata lines follow until we hit the content line (prefixed with tab).
    while (i < rows.length && !rows[i]!.startsWith("\t")) {
      const row = rows[i]!;
      if (row.startsWith("author ")) author = row.slice(7);
      else if (row.startsWith("author-time ")) {
        const ts = Number(row.slice("author-time ".length));
        if (!Number.isNaN(ts)) {
          date = new Date(ts * 1000).toISOString();
        }
      }
      i++;
    }
    const content = (rows[i] ?? "").slice(1); // strip the leading tab
    i++;
    commitCache.set(hash, { author, date, shortHash });
    lines.push({ lineNumber, hash, shortHash, author, date, content });
  }
  return lines;
}

export async function gitBranches(input: GitBranchesInput): Promise<GitBranchesResult> {
  const args = [
    "for-each-ref",
    "--format=%(HEAD)\x1f%(refname:short)\x1f%(upstream:short)\x1f%(objectname:short)\x1f%(contents:subject)",
  ];
  args.push("refs/heads");
  if (input.includeRemote) args.push("refs/remotes");
  const raw = await runGit(input.cwd, args);
  const branches: GitBranchEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [headMarker, name, upstream, tipHash, subject] = line.split("\x1f");
    if (!name) continue;
    // Skip the "HEAD" synthetic ref on remotes (e.g., "origin/HEAD ->
    // origin/main") — users never want to operate on it directly.
    if (name.endsWith("/HEAD")) continue;
    branches.push({
      name,
      current: headMarker === "*",
      remote: name.includes("/") && !name.startsWith("refs/"),
      upstream: upstream || null,
      tipHash: tipHash || null,
      tipSubject: subject || null,
    });
  }
  return { branches };
}

export async function gitCheckout(input: GitCheckoutInput): Promise<GitCheckoutResult> {
  // Capture the current branch before the switch so callers have a breadcrumb
  // to go back without having to remember it separately.
  let previous: string | null = null;
  try {
    previous = (await runGit(input.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (previous === "HEAD") previous = null; // detached
  } catch {
    previous = null;
  }
  if (input.create) {
    const args = ["checkout", "-b", input.branch];
    if (input.startPoint) args.push(input.startPoint);
    await runGit(input.cwd, args);
    return { branch: input.branch, created: true, previous };
  }
  await runGit(input.cwd, ["checkout", input.branch]);
  return { branch: input.branch, created: false, previous };
}

export async function gitStash(input: GitStashInput): Promise<GitStashResult> {
  switch (input.action) {
    case "list": {
      const raw = await runGit(input.cwd, [
        "stash",
        "list",
        "--format=%gd\x1f%s",
      ]);
      const entries: GitStashEntry[] = [];
      for (const line of raw.split("\n")) {
        if (!line) continue;
        const [ref, subject] = line.split("\x1f");
        if (!ref) continue;
        entries.push({ ref, subject: subject ?? "" });
      }
      return { action: "list", entries };
    }
    case "save": {
      // `stash push` is the modern form; `stash save` is deprecated.
      const args = ["stash", "push"];
      if (input.includeUntracked) args.push("-u");
      if (input.message) args.push("-m", input.message);
      const out = await runGit(input.cwd, args);
      return { action: "save", message: out.trim() };
    }
    case "pop":
    case "drop":
    case "apply": {
      const args = ["stash", input.action];
      if (input.ref) args.push(input.ref);
      const out = await runGit(input.cwd, args);
      return { action: input.action, message: out.trim() };
    }
  }
}

// ─── internals ──────────────────────────────────────────────────────

function runGit(
  cwd: string,
  args: string[],
  opts: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stopped = false;
    const p = spawn("git", args, { cwd });
    p.stdout.on("data", (d: Buffer) => {
      if (stopped) return;
      const room = maxBytes - stdout.length;
      if (room <= 0) {
        stopped = true;
        try {
          p.kill();
        } catch {}
        return;
      }
      if (d.length > room) {
        stdout += d.subarray(0, room).toString("utf-8");
        stopped = true;
        try {
          p.kill();
        } catch {}
      } else {
        stdout += d.toString("utf-8");
      }
    });
    p.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0 || stopped) {
        resolve(stdout);
        return;
      }
      reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}
