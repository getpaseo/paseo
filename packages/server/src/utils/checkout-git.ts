import { exec, execFile, spawn } from "child_process";
import { promisify } from "util";
import { resolve, dirname, basename } from "path";
import { realpathSync } from "fs";
import { open as openFile, stat as statFile } from "fs/promises";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";
import { parseAndHighlightDiff } from "../server/utils/diff-highlighter.js";
import { isPaseoOwnedWorktreeCwd } from "./worktree.js";
import { requirePaseoWorktreeBaseRefName } from "./worktree-metadata.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};

const SMALL_OUTPUT_MAX_BUFFER = 20 * 1024 * 1024; // 20MB

async function execGit(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, { ...options, maxBuffer: SMALL_OUTPUT_MAX_BUFFER });
}

type LimitedTextResult = {
  text: string;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

async function spawnLimitedText(params: {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxBytes: number;
  acceptExitCodes?: number[];
}): Promise<LimitedTextResult> {
  const accept = new Set(params.acceptExitCodes ?? [0]);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(params.cmd, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;

    const stop = () => {
      if (child.killed) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > params.maxBytes) {
        truncated = true;
        stop();
        return;
      }
      stdoutChunks.push(chunk);
    });

    // We don't buffer stderr (it can be large too). Keep it minimal for debugging.
    let stderrPreview = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrPreview.length > 2048) return;
      stderrPreview += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      if (code !== null && !accept.has(code) && !truncated) {
        rejectPromise(new Error(`Command failed: ${params.cmd} ${params.args.join(" ")} (code ${code})\n${stderrPreview}`));
        return;
      }
      resolvePromise({
        text: Buffer.concat(stdoutChunks).toString("utf8"),
        truncated,
        exitCode: code,
        signal,
      });
    });
  });
}

type CheckoutFileChange = {
  path: string;
  oldPath?: string;
  status: string;
  isNew: boolean;
  isDeleted: boolean;
  isUntracked?: boolean;
};

async function listCheckoutFileChanges(cwd: string, ref: string): Promise<CheckoutFileChange[]> {
  const changes: CheckoutFileChange[] = [];

  const { stdout: nameStatusOut } = await execGit(`git diff --name-status ${ref}`, {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  for (const line of nameStatusOut.split("\n").map((l) => l.trim()).filter(Boolean)) {
    // `--name-status` uses TAB separators, which preserves filenames with spaces.
    const tabParts = line.split("\t");
    const rawStatus = (tabParts[0] ?? "").trim();
    if (!rawStatus) continue;

    if (rawStatus.startsWith("R") || rawStatus.startsWith("C")) {
      const oldPath = tabParts[1];
      const newPath = tabParts[2];
      if (newPath) {
        changes.push({
          path: newPath,
          ...(oldPath ? { oldPath } : {}),
          status: rawStatus,
          isNew: false,
          isDeleted: false,
        });
      }
      continue;
    }

    const path = tabParts[1];
    if (!path) continue;
    const code = rawStatus[0];
    changes.push({
      path,
      status: rawStatus,
      isNew: code === "A",
      isDeleted: code === "D",
    });
  }

  const { stdout: untrackedOut } = await execGit("git ls-files --others --exclude-standard", {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  for (const file of untrackedOut.split("\n").map((l) => l.trim()).filter(Boolean)) {
    changes.push({
      path: file,
      status: "U",
      isNew: true,
      isDeleted: false,
      isUntracked: true,
    });
  }

  // Deduplicate by path (prefer tracked status over untracked marker if both appear).
  const byPath = new Map<string, CheckoutFileChange>();
  for (const change of changes) {
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, change);
      continue;
    }
    if (existing.isUntracked && !change.isUntracked) {
      byPath.set(change.path, change);
    }
  }
  return Array.from(byPath.values());
}

async function tryResolveMergeBase(cwd: string, baseRef: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(`git merge-base ${baseRef} HEAD`, { cwd, env: READ_ONLY_GIT_ENV });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

type FileStat = { additions: number; deletions: number; isBinary: boolean } | null;

async function tryGetNumstat(
  cwd: string,
  args: string[]
): Promise<FileStat> {
  try {
    const { text } = await spawnLimitedText({
      cmd: "git",
      args,
      cwd,
      env: READ_ONLY_GIT_ENV,
      maxBytes: 64 * 1024,
      acceptExitCodes: [0],
    });
    const line = text.trim().split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    if (!line) return null;
    const [aRaw, dRaw] = line.split(/\s+/);
    if (!aRaw || !dRaw) return null;
    if (aRaw === "-" || dRaw === "-") {
      return { additions: 0, deletions: 0, isBinary: true };
    }
    const additions = Number.parseInt(aRaw, 10);
    const deletions = Number.parseInt(dRaw, 10);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) {
      return null;
    }
    return { additions, deletions, isBinary: false };
  } catch {
    return null;
  }
}

export class NotGitRepoError extends Error {
  readonly cwd: string;
  readonly code = "NOT_GIT_REPO";

  constructor(cwd: string) {
    super(`Not a git repository: ${cwd}`);
    this.name = "NotGitRepoError";
    this.cwd = cwd;
  }
}

export class MergeConflictError extends Error {
  readonly baseRef: string;
  readonly currentBranch: string;
  readonly conflictFiles: string[];

  constructor(options: { baseRef: string; currentBranch: string; conflictFiles: string[] }) {
    super(`Merge conflict while merging ${options.currentBranch} into ${options.baseRef}`);
    this.name = "MergeConflictError";
    this.baseRef = options.baseRef;
    this.currentBranch = options.currentBranch;
    this.conflictFiles = options.conflictFiles;
  }
}

export class MergeFromBaseConflictError extends Error {
  readonly baseRef: string;
  readonly currentBranch: string;
  readonly conflictFiles: string[];

  constructor(options: { baseRef: string; currentBranch: string; conflictFiles: string[] }) {
    super(
      `Merge conflict while merging ${options.baseRef} into ${options.currentBranch}. Please merge manually.`
    );
    this.name = "MergeFromBaseConflictError";
    this.baseRef = options.baseRef;
    this.currentBranch = options.currentBranch;
    this.conflictFiles = options.conflictFiles;
  }
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface CheckoutStatus {
  isGit: false;
}

export type CheckoutStatusGitNonPaseo = {
  isGit: true;
  repoRoot: string;
  currentBranch: string | null;
  isDirty: boolean;
  baseRef: string | null;
  aheadBehind: AheadBehind | null;
  aheadOfOrigin: number | null;
  hasRemote: boolean;
  remoteUrl: string | null;
  isPaseoOwnedWorktree: false;
};

export type CheckoutStatusGitPaseo = {
  isGit: true;
  repoRoot: string;
  mainRepoRoot: string;
  currentBranch: string | null;
  isDirty: boolean;
  baseRef: string;
  aheadBehind: AheadBehind | null;
  aheadOfOrigin: number | null;
  hasRemote: boolean;
  remoteUrl: string | null;
  isPaseoOwnedWorktree: true;
};

export type CheckoutStatusGit = CheckoutStatusGitNonPaseo | CheckoutStatusGitPaseo;

export type CheckoutStatusResult = CheckoutStatus | CheckoutStatusGit;

export type CheckoutStatusLiteNotGit = {
  isGit: false;
  currentBranch: null;
  remoteUrl: null;
  isPaseoOwnedWorktree: false;
  mainRepoRoot: null;
};

export type CheckoutStatusLiteGitNonPaseo = {
  isGit: true;
  currentBranch: string | null;
  remoteUrl: string | null;
  isPaseoOwnedWorktree: false;
  mainRepoRoot: null;
};

export type CheckoutStatusLiteGitPaseo = {
  isGit: true;
  currentBranch: string | null;
  remoteUrl: string | null;
  isPaseoOwnedWorktree: true;
  mainRepoRoot: string;
};

export type CheckoutStatusLiteResult =
  | CheckoutStatusLiteNotGit
  | CheckoutStatusLiteGitNonPaseo
  | CheckoutStatusLiteGitPaseo;

export interface CheckoutDiffResult {
  diff: string;
  structured?: ParsedDiffFile[];
}

export interface CheckoutDiffCompare {
  mode: "uncommitted" | "base";
  baseRef?: string;
  includeStructured?: boolean;
}

export interface MergeToBaseOptions {
  baseRef?: string;
  mode?: "merge" | "squash";
  commitMessage?: string;
}

export interface MergeFromBaseOptions {
  baseRef?: string;
  requireCleanTarget?: boolean;
}

export type CheckoutContext = {
  paseoHome?: string;
};

function isGitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /not a git repository/i.test(error.message) || /git repository/i.test(error.message);
}

async function requireGitRepo(cwd: string): Promise<void> {
  try {
    await execAsync("git rev-parse --git-dir", { cwd, env: READ_ONLY_GIT_ENV });
  } catch (error) {
    throw new NotGitRepoError(cwd);
  }
}

async function getCurrentBranch(cwd: string): Promise<string | null> {
  const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  const branch = stdout.trim();
  return branch.length > 0 ? branch : null;
}

async function getWorktreeRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      "git rev-parse --path-format=absolute --show-toplevel",
      { cwd, env: READ_ONLY_GIT_ENV }
    );
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

async function getMainRepoRoot(cwd: string): Promise<string> {
  const { stdout: commonDirOut } = await execAsync(
    "git rev-parse --path-format=absolute --git-common-dir",
    { cwd, env: READ_ONLY_GIT_ENV }
  );
  const commonDir = commonDirOut.trim();
  const normalized = realpathSync(commonDir);

  if (basename(normalized) === ".git") {
    return dirname(normalized);
  }

  const { stdout: worktreeOut } = await execAsync("git worktree list --porcelain", {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  const worktrees = parseWorktreeList(worktreeOut);
  const nonBareNonPaseo = worktrees.filter(
    (wt) => !wt.isBare && !wt.path.includes("/.paseo/worktrees/")
  );
  const childrenOfBareRepo = nonBareNonPaseo.filter((wt) =>
    wt.path.startsWith(normalized + "/")
  );
  const mainChild = childrenOfBareRepo.find((wt) => basename(wt.path) === "main");
  return mainChild?.path ?? childrenOfBareRepo[0]?.path ?? nonBareNonPaseo[0]?.path ?? normalized;
}

type GitWorktreeEntry = {
  path: string;
  branchRef?: string;
  isBare?: boolean;
};

function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { path: trimmed.slice("worktree ".length).trim() };
      continue;
    }
    if (current && trimmed.startsWith("branch ")) {
      current.branchRef = trimmed.slice("branch ".length).trim();
    }
    if (current && trimmed === "bare") {
      current.isBare = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

async function getWorktreePathForBranch(
  cwd: string,
  branchName: string
): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const entries = parseWorktreeList(stdout);
    const ref = branchName.startsWith("refs/heads/")
      ? branchName
      : `refs/heads/${branchName}`;
    return entries.find((entry) => entry.branchRef === ref)?.path ?? null;
  } catch {
    return null;
  }
}

export async function renameCurrentBranch(
  cwd: string,
  newName: string
): Promise<{ previousBranch: string | null; currentBranch: string | null }> {
  await requireGitRepo(cwd);

  const previousBranch = await getCurrentBranch(cwd);
  if (!previousBranch || previousBranch === "HEAD") {
    throw new Error("Cannot rename branch in detached HEAD state");
  }

  await execAsync(`git branch -m "${newName}"`, {
    cwd,
  });

  const currentBranch = await getCurrentBranch(cwd);
  return { previousBranch, currentBranch };
}

type ConfiguredBaseRefForCwd =
  | { baseRef: null; isPaseoOwnedWorktree: false }
  | { baseRef: string; isPaseoOwnedWorktree: true };

async function getConfiguredBaseRefForCwd(
  cwd: string,
  context?: CheckoutContext
): Promise<ConfiguredBaseRefForCwd> {
  // Fast-path reject: non-worktree paths do not need expensive ownership checks.
  if (!/[\\/]worktrees[\\/]/.test(cwd)) {
    return { baseRef: null, isPaseoOwnedWorktree: false };
  }

  const ownership = await isPaseoOwnedWorktreeCwd(cwd, { paseoHome: context?.paseoHome });
  if (!ownership.allowed) {
    return { baseRef: null, isPaseoOwnedWorktree: false };
  }

  const worktreeRoot = (await getWorktreeRoot(cwd)) ?? cwd;
  return {
    baseRef: requirePaseoWorktreeBaseRefName(worktreeRoot),
    isPaseoOwnedWorktree: true,
  };
}

async function isWorkingTreeDirty(cwd: string): Promise<boolean> {
  const { stdout } = await execAsync("git status --porcelain", {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  return stdout.trim().length > 0;
}

async function getOriginRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git config --get remote.origin.url", {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

async function hasOriginRemote(cwd: string): Promise<boolean> {
  const url = await getOriginRemoteUrl(cwd);
  return url !== null;
}

async function resolveBaseRef(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git symbolic-ref --quiet refs/remotes/origin/HEAD", {
      cwd: repoRoot,
      env: READ_ONLY_GIT_ENV,
    });
    const ref = stdout.trim();
    if (ref) {
      // Prefer a local branch name (e.g. "main") over the remote-tracking ref (e.g. "origin/main")
      // so that status/diff/merge all operate against the same base ref.
      const remoteShort = ref.replace(/^refs\/remotes\//, "");
      const localName = remoteShort.startsWith("origin/")
        ? remoteShort.slice("origin/".length)
        : remoteShort;
      try {
        await execAsync(`git show-ref --verify --quiet refs/heads/${localName}`, {
          cwd: repoRoot,
          env: READ_ONLY_GIT_ENV,
        });
        return localName;
      } catch {
        return remoteShort;
      }
    }
  } catch {
    // ignore
  }

  const { stdout } = await execAsync("git branch --format='%(refname:short)'", {
    cwd: repoRoot,
    env: READ_ONLY_GIT_ENV,
  });
  const branches = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (branches.includes("main")) {
    return "main";
  }
  if (branches.includes("master")) {
    return "master";
  }

  return null;
}

function normalizeLocalBranchRefName(input: string): string {
  return input.startsWith("origin/") ? input.slice("origin/".length) : input;
}

async function doesGitRefExist(cwd: string, fullRef: string): Promise<boolean> {
  try {
    await execAsync(`git show-ref --verify --quiet ${fullRef}`, {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveBestBaseRefForMerge(cwd: string, normalizedBaseRef: string): Promise<string> {
  const [hasLocal, hasOrigin] = await Promise.all([
    doesGitRefExist(cwd, `refs/heads/${normalizedBaseRef}`),
    doesGitRefExist(cwd, `refs/remotes/origin/${normalizedBaseRef}`),
  ]);

  if (hasLocal && !hasOrigin) {
    return normalizedBaseRef;
  }
  if (!hasLocal && hasOrigin) {
    return `origin/${normalizedBaseRef}`;
  }
  if (!hasLocal && !hasOrigin) {
    throw new Error(`Base branch not found locally or on origin: ${normalizedBaseRef}`);
  }

  // Both exist: choose the ref with more unique commits compared to the other.
  try {
    const { stdout } = await execAsync(
      `git rev-list --left-right --count ${normalizedBaseRef}...origin/${normalizedBaseRef}`,
      { cwd, env: READ_ONLY_GIT_ENV }
    );
    const [localOnlyRaw, originOnlyRaw] = stdout.trim().split(/\s+/);
    const localOnly = Number.parseInt(localOnlyRaw ?? "0", 10);
    const originOnly = Number.parseInt(originOnlyRaw ?? "0", 10);
    if (!Number.isNaN(localOnly) && !Number.isNaN(originOnly) && originOnly > localOnly) {
      return `origin/${normalizedBaseRef}`;
    }
  } catch {
    // ignore and fall back to local
  }

  return normalizedBaseRef;
}

async function getAheadBehind(cwd: string, baseRef: string, currentBranch: string): Promise<AheadBehind | null> {
  const normalizedBaseRef = normalizeLocalBranchRefName(baseRef);
  if (!normalizedBaseRef || !currentBranch || normalizedBaseRef === currentBranch) {
    return null;
  }
  const { stdout } = await execAsync(
    `git rev-list --left-right --count ${normalizedBaseRef}...${currentBranch}`,
    { cwd, env: READ_ONLY_GIT_ENV }
  );
  const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? "0", 10);
  const ahead = Number.parseInt(aheadRaw ?? "0", 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) {
    return null;
  }
  return { ahead, behind };
}

async function getAheadOfOrigin(cwd: string, currentBranch: string): Promise<number | null> {
  if (!currentBranch) {
    return null;
  }
  try {
    const { stdout } = await execAsync(
      `git rev-list --count origin/${currentBranch}..${currentBranch}`,
      { cwd, env: READ_ONLY_GIT_ENV }
    );
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

type CheckoutInspectionContext = {
  worktreeRoot: string;
  currentBranch: string | null;
  remoteUrl: string | null;
  configured: ConfiguredBaseRefForCwd;
};

async function inspectCheckoutContext(
  cwd: string,
  context?: CheckoutContext
): Promise<CheckoutInspectionContext | null> {
  try {
    const root = await getWorktreeRoot(cwd);
    if (!root) {
      return null;
    }

    const [currentBranch, remoteUrl, configured] = await Promise.all([
      getCurrentBranch(cwd),
      getOriginRemoteUrl(cwd),
      getConfiguredBaseRefForCwd(cwd, context),
    ]);

    return {
      worktreeRoot: root,
      currentBranch,
      remoteUrl,
      configured,
    };
  } catch (error) {
    if (isGitError(error)) {
      return null;
    }
    throw error;
  }
}

const PER_FILE_DIFF_MAX_BYTES = 1024 * 1024; // 1MB
const TOTAL_DIFF_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const UNTRACKED_BINARY_SNIFF_BYTES = 16 * 1024;

async function isLikelyBinaryFile(absolutePath: string): Promise<boolean> {
  const handle = await openFile(absolutePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(UNTRACKED_BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      return false;
    }

    let suspicious = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      const byte = buffer[i];
      if (byte === 0) {
        return true;
      }
      // Treat control bytes as suspicious while allowing common whitespace.
      if (byte < 7 || (byte > 14 && byte < 32) || byte === 127) {
        suspicious += 1;
      }
    }

    return suspicious / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

async function inspectUntrackedFile(
  cwd: string,
  relativePath: string
): Promise<{ stat: FileStat; truncated: boolean }> {
  const absolutePath = resolve(cwd, relativePath);
  const metadata = await statFile(absolutePath);

  if (!metadata.isFile()) {
    return { stat: null, truncated: false };
  }

  if (await isLikelyBinaryFile(absolutePath)) {
    return {
      stat: { additions: 0, deletions: 0, isBinary: true },
      truncated: false,
    };
  }

  if (metadata.size > PER_FILE_DIFF_MAX_BYTES) {
    return {
      stat: { additions: 0, deletions: 0, isBinary: false },
      truncated: true,
    };
  }

  return {
    stat: { additions: 0, deletions: 0, isBinary: false },
    truncated: false,
  };
}

function buildPlaceholderParsedDiffFile(
  change: CheckoutFileChange,
  options: { status: "too_large" | "binary"; stat?: FileStat }
): ParsedDiffFile {
  return {
    path: change.path,
    isNew: change.isNew,
    isDeleted: change.isDeleted,
    additions: options.stat?.additions ?? 0,
    deletions: options.stat?.deletions ?? 0,
    hunks: [],
    status: options.status,
  };
}

async function getPerFileDiffText(
  cwd: string,
  ref: string,
  change: CheckoutFileChange
): Promise<{ text: string; truncated: boolean; stat: FileStat }> {
  if (change.isUntracked) {
    try {
      const inspected = await inspectUntrackedFile(cwd, change.path);
      if (inspected.stat?.isBinary || inspected.truncated) {
        return { text: "", truncated: inspected.truncated, stat: inspected.stat };
      }
    } catch {
      // Fall through to git diff path if metadata probing fails.
    }

    const result = await spawnLimitedText({
      cmd: "git",
      args: ["diff", "--no-index", "/dev/null", "--", change.path],
      cwd,
      env: READ_ONLY_GIT_ENV,
      maxBytes: PER_FILE_DIFF_MAX_BYTES,
      acceptExitCodes: [0, 1],
    });
    return {
      text: result.text,
      truncated: result.truncated,
      stat: { additions: 0, deletions: 0, isBinary: false },
    };
  }

  const stat = await tryGetNumstat(cwd, ["diff", "--numstat", ref, "--", change.path]);
  if (stat?.isBinary) {
    return { text: "", truncated: false, stat };
  }

  const result = await spawnLimitedText({
    cmd: "git",
    args: ["diff", ref, "--", change.path],
    cwd,
    env: READ_ONLY_GIT_ENV,
    maxBytes: PER_FILE_DIFF_MAX_BYTES,
  });
  return { text: result.text, truncated: result.truncated, stat };
}

export async function getCheckoutStatus(
  cwd: string,
  context?: CheckoutContext
): Promise<CheckoutStatusResult> {
  const inspected = await inspectCheckoutContext(cwd, context);
  if (!inspected) {
    return { isGit: false };
  }

  const worktreeRoot = inspected.worktreeRoot;
  const currentBranch = inspected.currentBranch;
  const remoteUrl = inspected.remoteUrl;
  const configured = inspected.configured;
  const isDirty = await isWorkingTreeDirty(cwd);
  const hasRemote = remoteUrl !== null;
  const baseRef = configured.baseRef ?? (await resolveBaseRef(cwd));
  const aheadBehind =
    baseRef && currentBranch ? await getAheadBehind(cwd, baseRef, currentBranch) : null;
  const aheadOfOrigin =
    hasRemote && currentBranch ? await getAheadOfOrigin(cwd, currentBranch) : null;

  if (configured.isPaseoOwnedWorktree) {
    const mainRepoRoot = await getMainRepoRoot(cwd);
    return {
      isGit: true,
      repoRoot: worktreeRoot,
      mainRepoRoot,
      currentBranch,
      isDirty,
      baseRef: configured.baseRef,
      aheadBehind,
      aheadOfOrigin,
      hasRemote,
      remoteUrl,
      isPaseoOwnedWorktree: true,
    };
  }

  return {
    isGit: true,
    repoRoot: worktreeRoot,
    currentBranch,
    isDirty,
    baseRef,
    aheadBehind,
    aheadOfOrigin,
    hasRemote,
    remoteUrl,
    isPaseoOwnedWorktree: false,
  };
}

export async function getCheckoutStatusLite(
  cwd: string,
  context?: CheckoutContext
): Promise<CheckoutStatusLiteResult> {
  const inspected = await inspectCheckoutContext(cwd, context);
  if (!inspected) {
    return {
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    };
  }

  if (inspected.configured.isPaseoOwnedWorktree) {
    return {
      isGit: true,
      currentBranch: inspected.currentBranch,
      remoteUrl: inspected.remoteUrl,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: await getMainRepoRoot(cwd),
    };
  }

  return {
    isGit: true,
    currentBranch: inspected.currentBranch,
    remoteUrl: inspected.remoteUrl,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  };
}

export async function getCheckoutDiff(
  cwd: string,
  compare: CheckoutDiffCompare,
  context?: CheckoutContext
): Promise<CheckoutDiffResult> {
  await requireGitRepo(cwd);

  let refForDiff: string;

  if (compare.mode === "uncommitted") {
    refForDiff = "HEAD";
  } else {
    const configured = await getConfiguredBaseRefForCwd(cwd, context);
    const baseRef = configured.baseRef ?? compare.baseRef ?? (await resolveBaseRef(cwd));
    if (!baseRef) {
      return { diff: "" };
    }
    if (configured.isPaseoOwnedWorktree && compare.baseRef && compare.baseRef !== baseRef) {
      throw new Error(`Base ref mismatch: expected ${baseRef}, got ${compare.baseRef}`);
    }

    const normalizedBaseRef = normalizeLocalBranchRefName(baseRef);
    const bestBaseRef = await resolveBestBaseRefForMerge(cwd, normalizedBaseRef);
    refForDiff = (await tryResolveMergeBase(cwd, bestBaseRef)) ?? bestBaseRef;
  }

  const changes = await listCheckoutFileChanges(cwd, refForDiff);
  changes.sort((a, b) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });

  const structured: ParsedDiffFile[] = [];
  let diffText = "";
  let diffBytes = 0;
  const appendDiff = (text: string) => {
    if (!text) return;
    if (diffBytes >= TOTAL_DIFF_MAX_BYTES) return;
    const buf = Buffer.from(text, "utf8");
    if (diffBytes + buf.length <= TOTAL_DIFF_MAX_BYTES) {
      diffText += text;
      diffBytes += buf.length;
      return;
    }
    const remaining = TOTAL_DIFF_MAX_BYTES - diffBytes;
    if (remaining > 0) {
      diffText += buf.subarray(0, remaining).toString("utf8");
      diffBytes = TOTAL_DIFF_MAX_BYTES;
    }
  };

  for (const change of changes) {
    const { text, truncated, stat } = await getPerFileDiffText(cwd, refForDiff, change);

    if (!compare.includeStructured) {
      if (stat?.isBinary) {
        appendDiff(`# ${change.path}: binary diff omitted\n`);
      } else if (truncated) {
        appendDiff(`# ${change.path}: diff too large omitted\n`);
      } else {
        appendDiff(text);
      }
      if (diffBytes >= TOTAL_DIFF_MAX_BYTES) {
        break;
      }
      continue;
    }

    if (stat?.isBinary) {
      structured.push(buildPlaceholderParsedDiffFile(change, { status: "binary", stat }));
      appendDiff(`# ${change.path}: binary diff omitted\n`);
      continue;
    }

    if (truncated) {
      structured.push(buildPlaceholderParsedDiffFile(change, { status: "too_large", stat }));
      appendDiff(`# ${change.path}: diff too large omitted\n`);
      continue;
    }

    appendDiff(text);
    const parsed = await parseAndHighlightDiff(text, cwd);
    const parsedFile =
      parsed[0] ??
      ({
        path: change.path,
        isNew: change.isNew,
        isDeleted: change.isDeleted,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        hunks: [],
      } satisfies ParsedDiffFile);

    structured.push({
      ...parsedFile,
      path: change.path,
      isNew: change.isNew,
      isDeleted: change.isDeleted,
      status: "ok",
    });
  }

  if (compare.includeStructured) {
    return { diff: diffText, structured };
  }
  return { diff: diffText };
}

export async function commitChanges(
  cwd: string,
  options: { message: string; addAll?: boolean }
): Promise<void> {
  await requireGitRepo(cwd);
  if (options.addAll ?? true) {
    await execFileAsync("git", ["add", "-A"], { cwd });
  }
  await execFileAsync("git", ["-c", "commit.gpgsign=false", "commit", "-m", options.message], {
    cwd,
  });
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await commitChanges(cwd, { message, addAll: true });
}

export async function mergeToBase(
  cwd: string,
  options: MergeToBaseOptions = {},
  context?: CheckoutContext
): Promise<void> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const configured = await getConfiguredBaseRefForCwd(cwd, context);
  const baseRef = configured.baseRef ?? options.baseRef ?? (await resolveBaseRef(cwd));
  if (!baseRef) {
    throw new Error("Unable to determine base branch for merge");
  }
  if (configured.isPaseoOwnedWorktree && options.baseRef && options.baseRef !== baseRef) {
    throw new Error(`Base ref mismatch: expected ${baseRef}, got ${options.baseRef}`);
  }
  if (!currentBranch) {
    throw new Error("Unable to determine current branch for merge");
  }
  let normalizedBaseRef = baseRef;
  normalizedBaseRef = normalizeLocalBranchRefName(normalizedBaseRef);
  if (normalizedBaseRef === currentBranch) {
    return;
  }

  const currentWorktreeRoot = (await getWorktreeRoot(cwd)) ?? cwd;
  const baseWorktree = await getWorktreePathForBranch(cwd, normalizedBaseRef);
  const operationCwd = baseWorktree ?? currentWorktreeRoot;
  const isSameCheckout = resolve(operationCwd) === resolve(currentWorktreeRoot);
  const originalBranch = await getCurrentBranch(operationCwd);
  const mode = options.mode ?? "merge";
  try {
    await execAsync(`git checkout ${normalizedBaseRef}`, { cwd: operationCwd });
    if (mode === "squash") {
      await execAsync(`git merge --squash ${currentBranch}`, { cwd: operationCwd });
      const message =
        options.commitMessage ?? `Squash merge ${currentBranch} into ${normalizedBaseRef}`;
      await execFileAsync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", message],
        { cwd: operationCwd }
      );
    } else {
      await execAsync(`git merge ${currentBranch}`, { cwd: operationCwd });
    }
  } catch (error) {
    const errorDetails =
      error instanceof Error
        ? `${error.message}\n${(error as any).stderr ?? ""}\n${(error as any).stdout ?? ""}`
        : String(error);
    try {
      const [unmergedOutput, lsFilesOutput, statusOutput] = await Promise.all([
        execAsync("git diff --name-only --diff-filter=U", { cwd: operationCwd }),
        execAsync("git ls-files -u", { cwd: operationCwd }),
        execAsync("git status --porcelain", { cwd: operationCwd }),
      ]);
      const statusConflicts = statusOutput.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /^(UU|AA|DD|AU|UA|UD|DU)\s/.test(line))
        .map((line) => line.slice(3).trim());
      const conflicts = [
        ...unmergedOutput.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        ...lsFilesOutput.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split("\t").pop() as string),
        ...statusConflicts,
      ].filter(Boolean);
      const conflictDetected =
        conflicts.length > 0 || /CONFLICT|Automatic merge failed/i.test(errorDetails);
      if (conflictDetected) {
        try {
          await execAsync("git merge --abort", { cwd: operationCwd });
        } catch {
          // ignore
        }
        throw new MergeConflictError({
          baseRef: normalizedBaseRef,
          currentBranch,
          conflictFiles: conflicts.length > 0 ? conflicts : [],
        });
      }
    } catch (innerError) {
      if (innerError instanceof MergeConflictError) {
        throw innerError;
      }
      // ignore detection failures
    }

    throw error;
  } finally {
    if (isSameCheckout && originalBranch && originalBranch !== normalizedBaseRef) {
      try {
        await execAsync(`git checkout ${originalBranch}`, { cwd: operationCwd });
      } catch {
        // ignore
      }
    }
  }
}

export async function mergeFromBase(
  cwd: string,
  options: MergeFromBaseOptions = {},
  context?: CheckoutContext
): Promise<void> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  if (!currentBranch || currentBranch === "HEAD") {
    throw new Error("Unable to determine current branch for merge");
  }

  const configured = await getConfiguredBaseRefForCwd(cwd, context);
  const baseRef = configured.baseRef ?? options.baseRef ?? (await resolveBaseRef(cwd));
  if (!baseRef) {
    throw new Error("Unable to determine base branch for merge");
  }
  if (configured.isPaseoOwnedWorktree && options.baseRef && options.baseRef !== baseRef) {
    throw new Error(`Base ref mismatch: expected ${baseRef}, got ${options.baseRef}`);
  }

  const requireCleanTarget = options.requireCleanTarget ?? true;
  if (requireCleanTarget) {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    if (stdout.trim().length > 0) {
      throw new Error("Working directory has uncommitted changes.");
    }
  }

  const normalizedBaseRef = normalizeLocalBranchRefName(baseRef);
  const bestBaseRef = await resolveBestBaseRefForMerge(cwd, normalizedBaseRef);
  if (bestBaseRef === currentBranch) {
    return;
  }

  try {
    await execAsync(`git merge ${bestBaseRef}`, { cwd });
  } catch (error) {
    const errorDetails =
      error instanceof Error
        ? `${error.message}\n${(error as any).stderr ?? ""}\n${(error as any).stdout ?? ""}`
        : String(error);
    try {
      const [unmergedOutput, lsFilesOutput, statusOutput] = await Promise.all([
        execAsync("git diff --name-only --diff-filter=U", { cwd }),
        execAsync("git ls-files -u", { cwd }),
        execAsync("git status --porcelain", { cwd }),
      ]);
      const statusConflicts = statusOutput.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /^(UU|AA|DD|AU|UA|UD|DU)\s/.test(line))
        .map((line) => line.slice(3).trim());
      const conflicts = [
        ...unmergedOutput.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        ...lsFilesOutput.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split("\t").pop() as string),
        ...statusConflicts,
      ].filter(Boolean);
      const conflictDetected =
        conflicts.length > 0 || /CONFLICT|Automatic merge failed/i.test(errorDetails);
      if (conflictDetected) {
        try {
          await execAsync("git merge --abort", { cwd });
        } catch {
          // ignore
        }
        throw new MergeFromBaseConflictError({
          baseRef: bestBaseRef,
          currentBranch,
          conflictFiles: conflicts.length > 0 ? conflicts : [],
        });
      }
    } catch (innerError) {
      if (innerError instanceof MergeFromBaseConflictError) {
        throw innerError;
      }
      // ignore detection failures
    }

    throw error;
  }
}

export async function pushCurrentBranch(cwd: string): Promise<void> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  if (!currentBranch || currentBranch === "HEAD") {
    throw new Error("Unable to determine current branch for push");
  }
  const hasRemote = await hasOriginRemote(cwd);
  if (!hasRemote) {
    throw new Error("Remote 'origin' is not configured.");
  }
  await execAsync(`git push -u origin ${currentBranch}`, { cwd });
}

export interface CreatePullRequestOptions {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

export interface PullRequestStatus {
  url: string;
  title: string;
  state: string;
  baseRefName: string;
  headRefName: string;
}

async function ensureGhAvailable(cwd: string): Promise<void> {
  try {
    await execAsync("gh --version", { cwd });
  } catch {
    throw new Error("GitHub CLI (gh) is not available or not authenticated");
  }
}

async function resolveGitHubRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git config --get remote.origin.url", {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const url = stdout.trim();
    if (!url) {
      return null;
    }
    let cleaned = url;
    if (cleaned.startsWith("git@github.com:")) {
      cleaned = cleaned.slice("git@github.com:".length);
    } else if (cleaned.startsWith("https://github.com/")) {
      cleaned = cleaned.slice("https://github.com/".length);
    } else if (cleaned.startsWith("http://github.com/")) {
      cleaned = cleaned.slice("http://github.com/".length);
    } else {
      const marker = "github.com/";
      const index = cleaned.indexOf(marker);
      if (index !== -1) {
        cleaned = cleaned.slice(index + marker.length);
      } else {
        return null;
      }
    }
    if (cleaned.endsWith(".git")) {
      cleaned = cleaned.slice(0, -".git".length);
    }
    if (!cleaned.includes("/")) {
      return null;
    }
    return cleaned;
  } catch {
    // ignore
  }
  return null;
}

export async function createPullRequest(
  cwd: string,
  options: CreatePullRequestOptions
): Promise<{ url: string; number: number }> {
  await requireGitRepo(cwd);
  await ensureGhAvailable(cwd);
  const repo = await resolveGitHubRepo(cwd);
  if (!repo) {
    throw new Error("Unable to determine GitHub repo from git remote");
  }

  const head = options.head ?? (await getCurrentBranch(cwd));
  const configured = await getConfiguredBaseRefForCwd(cwd);
  const base = configured.baseRef ?? options.base ?? (await resolveBaseRef(cwd));
  if (!head) {
    throw new Error("Unable to determine head branch for PR");
  }
  if (!base) {
    throw new Error("Unable to determine base branch for PR");
  }
  const normalizedBase = normalizeLocalBranchRefName(base);
  if (configured.isPaseoOwnedWorktree && options.base && options.base !== base) {
    throw new Error(`Base ref mismatch: expected ${base}, got ${options.base}`);
  }

  await execAsync(`git push -u origin ${head}`, { cwd });

  const args = ["api", "-X", "POST", `repos/${repo}/pulls`, "-f", `title=${options.title}`];
  args.push("-f", `head=${head}`);
  args.push("-f", `base=${normalizedBase}`);
  if (options.body) {
    args.push("-f", `body=${options.body}`);
  }
  const { stdout } = await execFileAsync("gh", args, { cwd });
  const parsed = JSON.parse(stdout.trim());
  if (!parsed?.url || !parsed?.number) {
    throw new Error("GitHub CLI did not return PR url/number");
  }
  return { url: parsed.url, number: parsed.number };
}

export async function getPullRequestStatus(cwd: string): Promise<PullRequestStatus | null> {
  await requireGitRepo(cwd);
  await ensureGhAvailable(cwd);
  const repo = await resolveGitHubRepo(cwd);
  const head = await getCurrentBranch(cwd);
  if (!repo || !head) {
    return null;
  }
  const owner = repo.split("/")[0];
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      `repos/${repo}/pulls`,
      "-X",
      "GET",
      "-F",
      `head=${owner}:${head}`,
      "-F",
      "state=open",
    ],
    { cwd }
  );
  const parsed = JSON.parse(stdout.trim());
  const current = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
  if (!current) {
    return null;
  }
  return {
    url: current.html_url ?? current.url,
    title: current.title,
    state: current.state,
    baseRefName: current.base?.ref ?? "",
    headRefName: current.head?.ref ?? head,
  };
}
