import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
  const snapshot: WorkspaceSnapshot = {};
  for (const change of await uncommittedChanges(cwd)) {
    snapshot[change.filePath] = await hashOf(cwd, change.filePath);
  }
  return snapshot;
}

/**
 * Commit what the task changed to a branch of its own: files that are new or whose content
 * differs from the snapshot. Your earlier uncommitted changes stay uncommitted. Granularity
 * is the file, so a task that edits a file you had already edited takes your edits in with it.
 * Null when the task changed nothing.
 */
export async function commitWorkspaceChanges(input: {
  cwd: string;
  before: WorkspaceSnapshot;
  branch: string;
  message: string;
}): Promise<WorkspaceCommitResult | null> {
  const changed: ButChange[] = [];
  for (const change of await uncommittedChanges(input.cwd)) {
    const previous = input.before[change.filePath];
    if (previous === undefined || previous !== (await hashOf(input.cwd, change.filePath))) {
      changed.push(change);
    }
  }
  if (changed.length === 0) return null;
  await but(input.cwd, [
    "commit",
    "-b",
    input.branch,
    "-m",
    input.message,
    ...changed.map((c) => c.cliId),
  ]);
  return { branch: input.branch, files: changed.map((c) => c.filePath) };
}
