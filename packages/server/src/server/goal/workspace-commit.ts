import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runGitCommand } from "../../utils/run-git-command.js";
import { execCommand } from "../../utils/spawn.js";

const BUT_TIMEOUT_MS = 60_000;

/** File path to a hash of its content at one moment; "" for a file that is gone. */
export type WorkspaceSnapshot = Record<string, string>;

export interface WorkspaceCommitResult {
  branch: string;
  files: string[];
}

interface ButChange {
  cliId: string;
  filePath: string;
}

async function but(cwd: string, args: string[]): Promise<string> {
  const result = await execCommand("but", args, { cwd, timeout: BUT_TIMEOUT_MS });
  return result.stdout;
}

/** GitButler keeps `gitbutler/workspace` checked out while it manages a repository. */
async function followsGitButler(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGitCommand(["symbolic-ref", "--short", "-q", "HEAD"], { cwd });
    return stdout.trim().startsWith("gitbutler/");
  } catch {
    return false;
  }
}

/** Paths git lists as changed or untracked, from `status --porcelain -z`. */
async function gitUncommittedPaths(cwd: string): Promise<string[]> {
  const { stdout } = await runGitCommand(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd,
    },
  );
  const parts = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy lists the old path next.
    if (entry[0] === "R" || entry[0] === "C") i += 1;
  }
  return paths;
}

async function uncommittedChanges(cwd: string): Promise<ButChange[]> {
  const parsed: unknown = JSON.parse(await but(cwd, ["status", "--json"]));
  const list = (parsed as { uncommittedChanges?: unknown }).uncommittedChanges;
  if (!Array.isArray(list)) throw new Error("but status --json listed no uncommittedChanges");
  return list.filter(
    (c): c is ButChange =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as ButChange).cliId === "string" &&
      typeof (c as ButChange).filePath === "string",
  );
}

async function hashOf(cwd: string, filePath: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(path.join(cwd, filePath)))
      .digest("hex");
  } catch {
    return "";
  }
}

/**
 * What the checkout holds uncommitted before a task starts, so the task's own changes can be
 * told apart from yours afterwards. Throws when `but` cannot read the repository.
 */
export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const files = (await followsGitButler(cwd))
    ? (await uncommittedChanges(cwd)).map((c) => c.filePath)
    : await gitUncommittedPaths(cwd);
  const snapshot: WorkspaceSnapshot = {};
  for (const filePath of files) snapshot[filePath] = await hashOf(cwd, filePath);
  return snapshot;
}

/** Commits in one checkout run one at a time: parallel tasks would fight over the index lock. */
const commitQueues = new Map<string, Promise<unknown>>();

function inQueue<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const run = (commitQueues.get(cwd) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  commitQueues.set(cwd, tail);
  void tail.then(() => {
    if (commitQueues.get(cwd) === tail) commitQueues.delete(cwd);
    return undefined;
  });
  return run;
}

export interface WorkspaceCommitInput {
  cwd: string;
  before: WorkspaceSnapshot;
  /** GitButler: the branch made for the task. Plain git commits on the current branch. */
  branch: string;
  message: string;
  /** Only files this accepts are committed; the rest stay uncommitted. Default: all. */
  include?: (filePath: string) => boolean;
}

async function changedSince(
  input: WorkspaceCommitInput,
  files: readonly string[],
): Promise<string[]> {
  const changed: string[] = [];
  for (const filePath of files) {
    if (input.include && !input.include(filePath)) continue;
    const previous = input.before[filePath];
    if (previous === undefined || previous !== (await hashOf(input.cwd, filePath))) {
      changed.push(filePath);
    }
  }
  return changed;
}

/**
 * Commit what the task changed: files that are new or whose content differs from the snapshot.
 * Your earlier uncommitted changes stay uncommitted. Granularity is the file, so a task that
 * edits a file you had already edited takes your edits in with it. A GitButler checkout gets a
 * branch of its own for the task; any other repository gets a commit on the current branch,
 * without switching branches. Null when the task changed nothing.
 */
export function commitWorkspaceChanges(
  input: WorkspaceCommitInput,
): Promise<WorkspaceCommitResult | null> {
  return inQueue(input.cwd, () =>
    followsGitButler(input.cwd).then((gitbutler) =>
      gitbutler ? commitWithGitButler(input) : commitWithGit(input),
    ),
  );
}

async function commitWithGitButler(
  input: WorkspaceCommitInput,
): Promise<WorkspaceCommitResult | null> {
  const listed = await uncommittedChanges(input.cwd);
  const changed = await changedSince(
    input,
    listed.map((c) => c.filePath),
  );
  if (changed.length === 0) return null;
  const ids = listed.filter((c) => changed.includes(c.filePath)).map((c) => c.cliId);
  await but(input.cwd, ["commit", "-b", input.branch, "-m", input.message, ...ids]);
  return { branch: input.branch, files: changed };
}

async function commitWithGit(input: WorkspaceCommitInput): Promise<WorkspaceCommitResult | null> {
  const changed = await changedSince(input, await gitUncommittedPaths(input.cwd));
  if (changed.length === 0) return null;
  await runGitCommand(["add", "--all", "--", ...changed], { cwd: input.cwd });
  // Paths after `--` commit only those files, so what you staged yourself stays staged.
  await runGitCommand(["commit", "--only", "-m", input.message, "--", ...changed], {
    cwd: input.cwd,
  });
  const { stdout } = await runGitCommand(["symbolic-ref", "--short", "-q", "HEAD"], {
    cwd: input.cwd,
    acceptExitCodes: [0, 1],
  });
  return { branch: stdout.trim() || "HEAD", files: changed };
}
