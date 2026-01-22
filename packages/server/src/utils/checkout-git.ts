import { exec, execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
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

export async function renameCurrentBranch(
  cwd: string,
  newName: string
): Promise<{ previousBranch: string | null; currentBranch: string | null }> {
  await requireRepoInfo(cwd);

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

export async function commitChanges(
  cwd: string,
  options: { message: string; addAll?: boolean }
): Promise<void> {
  await requireRepoInfo(cwd);
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

  const operationCwd = repoInfo.path;
  const isSameCheckout = resolve(operationCwd) === resolve(cwd);
  const originalBranch = await getCurrentBranch(operationCwd);
  const mode = options.mode ?? "merge";
  try {
    await execAsync(`git checkout ${baseRef}`, { cwd: operationCwd });
    if (mode === "squash") {
      await execAsync(`git merge --squash ${currentBranch}`, { cwd: operationCwd });
      const message = options.commitMessage ?? `Squash merge ${currentBranch} into ${baseRef}`;
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
          baseRef,
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
    if (isSameCheckout && originalBranch && originalBranch !== baseRef) {
      try {
        await execAsync(`git checkout ${originalBranch}`, { cwd: operationCwd });
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
  await requireRepoInfo(cwd);
  await ensureGhAvailable(cwd);
  const repo = await resolveGitHubRepo(cwd);
  if (!repo) {
    throw new Error("Unable to determine GitHub repo from git remote");
  }

  const repoInfo = await detectRepoInfo(cwd);
  const head = options.head ?? (await getCurrentBranch(cwd));
  const base = options.base ?? (await resolveBaseRef(repoInfo.path));
  if (!head) {
    throw new Error("Unable to determine head branch for PR");
  }
  if (!base) {
    throw new Error("Unable to determine base branch for PR");
  }

  await execAsync(`git push -u origin ${head}`, { cwd });

  const args = ["api", "-X", "POST", `repos/${repo}/pulls`, "-f", `title=${options.title}`];
  args.push("-f", `head=${head}`);
  args.push("-f", `base=${base}`);
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
  await requireRepoInfo(cwd);
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
