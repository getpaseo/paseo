import { exec, execFile } from "child_process";
import { promisify } from "util";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";
import { parseDiff } from "../server/utils/diff-highlighter.js";
import { detectRepoInfo } from "./worktree.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};

export class NotGitRepoError extends Error {
  readonly cwd: string;

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

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface CheckoutStatus {
  isGit: boolean;
  repoRoot?: string;
  currentBranch?: string | null;
  isDirty?: boolean;
  baseRef?: string | null;
  aheadBehind?: AheadBehind | null;
}

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

function isGitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /not a git repository/i.test(error.message) || /git repository/i.test(error.message);
}

async function requireRepoInfo(cwd: string) {
  try {
    return await detectRepoInfo(cwd);
  } catch (error) {
    if (isGitError(error)) {
      throw new NotGitRepoError(cwd);
    }
    if (error instanceof Error) {
      throw new NotGitRepoError(cwd);
    }
    throw error;
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

async function isWorkingTreeDirty(cwd: string, repoType: "bare" | "normal"): Promise<boolean> {
  if (repoType === "bare") {
    return false;
  }
  const { stdout } = await execAsync("git status --porcelain", {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  return stdout.trim().length > 0;
}

async function resolveBaseRef(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git symbolic-ref --quiet refs/remotes/origin/HEAD", {
      cwd: repoRoot,
      env: READ_ONLY_GIT_ENV,
    });
    const ref = stdout.trim();
    if (ref) {
      return ref.replace(/^refs\/remotes\//, "");
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

async function getAheadBehind(cwd: string, baseRef: string, currentBranch: string): Promise<AheadBehind | null> {
  if (!baseRef || !currentBranch || baseRef === currentBranch) {
    return null;
  }
  const { stdout } = await execAsync(
    `git rev-list --left-right --count ${baseRef}...${currentBranch}`,
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

export async function getCheckoutStatus(cwd: string): Promise<CheckoutStatus> {
  let repoInfo: Awaited<ReturnType<typeof detectRepoInfo>>;
  try {
    repoInfo = await detectRepoInfo(cwd);
  } catch (error) {
    if (isGitError(error)) {
      return { isGit: false };
    }
    throw error;
  }

  const currentBranch = await getCurrentBranch(cwd);
  const isDirty = await isWorkingTreeDirty(cwd, repoInfo.type);
  const baseRef = await resolveBaseRef(repoInfo.path);
  const aheadBehind = baseRef && currentBranch
    ? await getAheadBehind(cwd, baseRef, currentBranch)
    : null;

  return {
    isGit: true,
    repoRoot: repoInfo.path,
    currentBranch,
    isDirty,
    baseRef,
    aheadBehind,
  };
}

export async function getCheckoutDiff(
  cwd: string,
  compare: CheckoutDiffCompare
): Promise<CheckoutDiffResult> {
  await requireRepoInfo(cwd);

  let diff = "";
  if (compare.mode === "uncommitted") {
    const { stdout: trackedDiff } = await execAsync("git diff HEAD", {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const untrackedDiff = await getUntrackedDiff(cwd);
    diff = trackedDiff + untrackedDiff;
  } else {
    const repoInfo = await detectRepoInfo(cwd);
    const baseRef = compare.baseRef ?? (await resolveBaseRef(repoInfo.path));
    if (!baseRef) {
      diff = "";
    } else {
      const { stdout } = await execAsync(`git diff ${baseRef}...HEAD`, {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      diff = stdout;
    }
  }

  if (compare.includeStructured) {
    return { diff, structured: parseDiff(diff) };
  }
  return { diff };
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await requireRepoInfo(cwd);
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], {
    cwd,
  });
}

export async function mergeToBase(cwd: string, options: MergeToBaseOptions = {}): Promise<void> {
  const repoInfo = await requireRepoInfo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const baseRef = options.baseRef ?? (await resolveBaseRef(repoInfo.path));
  if (!baseRef) {
    throw new Error("Unable to determine base branch for merge");
  }
  if (!currentBranch) {
    throw new Error("Unable to determine current branch for merge");
  }
  if (baseRef === currentBranch) {
    return;
  }

  const originalBranch = currentBranch;
  const mode = options.mode ?? "merge";
  try {
    await execAsync(`git checkout ${baseRef}`, { cwd });
    if (mode === "squash") {
      await execAsync(`git merge --squash ${originalBranch}`, { cwd });
      const message = options.commitMessage ?? `Squash merge ${originalBranch} into ${baseRef}`;
      await execFileAsync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], { cwd });
    } else {
      await execAsync(`git merge ${originalBranch}`, { cwd });
    }
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
        throw new MergeConflictError({
          baseRef,
          currentBranch: originalBranch,
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
    if (originalBranch !== baseRef) {
      try {
        await execAsync(`git checkout ${originalBranch}`, { cwd });
      } catch {
        // ignore
      }
    }
  }
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

export async function createPullRequest(cwd: string, options: CreatePullRequestOptions): Promise<{ url: string; number: number }> {
  await requireRepoInfo(cwd);
  await ensureGhAvailable(cwd);
  const args = ["pr", "create", "--json", "url,number", "--title", options.title];
  if (options.body) {
    args.push("--body", options.body);
  }
  if (options.base) {
    args.push("--base", options.base);
  }
  if (options.head) {
    args.push("--head", options.head);
  }
  if (options.draft) {
    args.push("--draft");
  }
  const { stdout } = await execAsync(`gh ${args.map((arg) => `"${arg}"`).join(" ")}`, {
    cwd,
  });
  const parsed = JSON.parse(stdout.trim());
  return { url: parsed.url, number: parsed.number };
}

export async function getPullRequestStatus(cwd: string): Promise<PullRequestStatus | null> {
  await requireRepoInfo(cwd);
  await ensureGhAvailable(cwd);
  const { stdout } = await execAsync(
    "gh pr status --json url,title,state,baseRefName,headRefName",
    { cwd }
  );
  const parsed = JSON.parse(stdout.trim());
  const current = parsed.currentBranch;
  if (!current) {
    return null;
  }
  return {
    url: current.url,
    title: current.title,
    state: current.state,
    baseRefName: current.baseRefName,
    headRefName: current.headRefName,
  };
}
