import { exec, execFile } from "child_process";
import { promisify } from "util";
import { resolve, dirname, basename } from "path";
import { realpathSync } from "fs";
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

async function getUntrackedDiff(cwd: string): Promise<string> {
  let untrackedDiff = "";
  try {
    const { stdout: untrackedFiles } = await execAsync(
      "git ls-files --others --exclude-standard",
      { cwd, env: READ_ONLY_GIT_ENV }
    );
    const newFiles = untrackedFiles.trim().split("\n").filter(Boolean);

    for (const file of newFiles) {
      try {
        const { stdout: fileDiff } = await execAsync(
          `git diff --no-index /dev/null "${file}" || true`,
          { cwd, env: READ_ONLY_GIT_ENV }
        );
        if (fileDiff) {
          untrackedDiff += fileDiff;
        }
      } catch {
        // Ignore errors for individual files
      }
    }
  } catch {
    // Ignore errors getting untracked files
  }
  return untrackedDiff;
}

export async function getCheckoutStatus(
  cwd: string,
  context?: CheckoutContext
): Promise<CheckoutStatusResult> {
  let worktreeRoot: string;
  try {
    const root = await getWorktreeRoot(cwd);
    if (!root) {
      return { isGit: false };
    }
    worktreeRoot = root;
  } catch (error) {
    if (isGitError(error)) {
      return { isGit: false };
    }
    throw error;
  }

  const currentBranch = await getCurrentBranch(cwd);
  const isDirty = await isWorkingTreeDirty(cwd);
  const remoteUrl = await getOriginRemoteUrl(cwd);
  const hasRemote = remoteUrl !== null;
  const configured = await getConfiguredBaseRefForCwd(cwd, context);
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

export async function getCheckoutDiff(
  cwd: string,
  compare: CheckoutDiffCompare,
  context?: CheckoutContext
): Promise<CheckoutDiffResult> {
  await requireGitRepo(cwd);

  let diff = "";
  if (compare.mode === "uncommitted") {
    const { stdout: trackedDiff } = await execAsync("git diff HEAD", {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const untrackedDiff = await getUntrackedDiff(cwd);
    diff = trackedDiff + untrackedDiff;
  } else {
    const configured = await getConfiguredBaseRefForCwd(cwd, context);
    const baseRef = configured.baseRef ?? compare.baseRef ?? (await resolveBaseRef(cwd));
    if (!baseRef) {
      diff = "";
    } else if (configured.isPaseoOwnedWorktree && compare.baseRef && compare.baseRef !== baseRef) {
      throw new Error(`Base ref mismatch: expected ${baseRef}, got ${compare.baseRef}`);
    } else {
      const normalizedBaseRef = normalizeLocalBranchRefName(baseRef);
      // Diff base ref against working tree (includes uncommitted changes)
      const { stdout: trackedDiff } = await execAsync(`git diff ${normalizedBaseRef}`, {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      const untrackedDiff = await getUntrackedDiff(cwd);
      diff = trackedDiff + untrackedDiff;
    }
  }

  if (compare.includeStructured) {
    return { diff, structured: await parseAndHighlightDiff(diff, cwd) };
  }
  return { diff };
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
