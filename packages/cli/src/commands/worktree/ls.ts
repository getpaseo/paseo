import type { Command } from "commander";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { execCommand, type DaemonClient } from "@getpaseo/server";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema, CommandError } from "../../output/index.js";

/** Worktree list item for display */
export interface WorktreeListItem {
  name: string;
  branch: string;
  cwd: string;
  agent: string;
}

/** Shorten home directory in path */
function shortenPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/** Extract worktree name from path */
function extractWorktreeName(path: string): string {
  return basename(path);
}

export function resolvePaseoHomePath(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

export function resolvePaseoWorktreesDir(): string {
  return join(resolvePaseoHomePath(), "worktrees");
}

function isAgentInManagedWorktree(agentCwd: string): boolean {
  const worktreesDir = resolvePaseoWorktreesDir();
  return agentCwd === worktreesDir || agentCwd.startsWith(worktreesDir + sep);
}

function getManagedWorktreeRootForCwd(agentCwd: string): string | null {
  if (!isAgentInManagedWorktree(agentCwd)) {
    return null;
  }

  const worktreesDir = resolvePaseoWorktreesDir();
  const relativePath = agentCwd.slice(worktreesDir.length + sep.length);
  const [projectDir, worktreeDir] = relativePath.split(sep).filter((part) => part.length > 0);
  return projectDir && worktreeDir ? join(worktreesDir, projectDir, worktreeDir) : null;
}

function normalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isPathWithinOrEqual(parent: string, candidate: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedCandidate = normalizePath(candidate);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(normalizedParent + sep)
  );
}

/** Schema for worktree ls output */
export const worktreeLsSchema: OutputSchema<WorktreeListItem> = {
  idField: "name",
  columns: [
    { header: "NAME", field: "name", width: 20 },
    { header: "BRANCH", field: "branch", width: 25 },
    { header: "CWD", field: "cwd", width: 45 },
    { header: "AGENT", field: "agent", width: 10 },
  ],
};

export type WorktreeLsResult = ListResult<WorktreeListItem>;

export interface WorktreeLsOptions extends CommandOptions {
  host?: string;
}

export interface PaseoWorktreeListEntry {
  worktreePath: string;
  createdAt: string;
  branchName: string | null;
  head: string | null;
}

export function parseGitWorktreeList(output: string): PaseoWorktreeListEntry[] {
  const entries: PaseoWorktreeListEntry[] = [];
  let current: { worktreePath: string; branchName: string | null; head: string | null } | null =
    null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push({ ...current, createdAt: resolveCreatedAt(current.worktreePath) });
      }
      current = {
        worktreePath: line.slice("worktree ".length).trim(),
        branchName: null,
        head: null,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim() || null;
    } else if (line.trim().length === 0) {
      entries.push({ ...current, createdAt: resolveCreatedAt(current.worktreePath) });
      current = null;
    }
  }

  if (current) {
    entries.push({ ...current, createdAt: resolveCreatedAt(current.worktreePath) });
  }

  return entries;
}

export function findManagedWorktreeByNameOrBranch(
  worktrees: PaseoWorktreeListEntry[],
  nameArg: string,
): PaseoWorktreeListEntry | null {
  const target = nameArg.trim();
  return (
    worktrees.find((worktree) => {
      const name = basename(worktree.worktreePath);
      return name === target || worktree.branchName === target;
    }) ?? null
  );
}

function resolveCreatedAt(worktreePath: string): string {
  try {
    const stats = statSync(worktreePath);
    const createdAtMs =
      Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
        ? stats.birthtimeMs
        : stats.ctimeMs;
    return new Date(createdAtMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function listManagedWorktreeProjectDirs(): string[] {
  const worktreesDir = resolvePaseoWorktreesDir();
  try {
    return readdirSync(worktreesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(worktreesDir, entry.name));
  } catch {
    return [];
  }
}

function listGitWorktreeCandidateCwds(projectDir: string): string[] {
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectDir, entry.name));
  } catch {
    return [];
  }
}

export async function listManagedWorktrees(): Promise<PaseoWorktreeListEntry[]> {
  const worktreesByPath = new Map<string, PaseoWorktreeListEntry>();

  for (const projectDir of listManagedWorktreeProjectDirs()) {
    const candidateCwds = listGitWorktreeCandidateCwds(projectDir);
    if (candidateCwds.length === 0) {
      continue;
    }

    let stdout: string | null = null;
    for (const cwd of candidateCwds) {
      try {
        ({ stdout } = await execCommand("git", ["worktree", "list", "--porcelain"], {
          cwd,
          timeout: 10_000,
        }));
        break;
      } catch {
        continue;
      }
    }

    if (stdout === null) {
      continue;
    }

    for (const worktree of parseGitWorktreeList(stdout)) {
      if (!isPathWithinOrEqual(projectDir, worktree.worktreePath)) {
        continue;
      }
      worktreesByPath.set(worktree.worktreePath, worktree);
    }
  }

  return Array.from(worktreesByPath.values());
}

export async function runLsCommand(
  options: WorktreeLsOptions,
  _command: Command,
): Promise<WorktreeLsResult> {
  const host = getDaemonHost({ host: options.host });

  let client: DaemonClient;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }

  try {
    const [agentsPayload, worktrees] = await Promise.all([
      client.fetchAgents({ scope: "active" }),
      listManagedWorktrees(),
    ]);
    const agents = agentsPayload.entries.map((entry) => entry.agent);

    await client.close();

    // Build a map of worktree paths to agent IDs
    const worktreeAgentMap = new Map<string, string>();
    for (const agent of agents) {
      const worktreeRoot = getManagedWorktreeRootForCwd(agent.cwd);
      if (worktreeRoot) {
        worktreeAgentMap.set(worktreeRoot, agent.id.slice(0, 7));
      }
    }

    const items: WorktreeListItem[] = worktrees.map((wt) => ({
      name: extractWorktreeName(wt.worktreePath),
      branch: wt.branchName ?? "-",
      cwd: shortenPath(wt.worktreePath),
      agent: worktreeAgentMap.get(wt.worktreePath) ?? "-",
    }));

    return {
      type: "list",
      data: items,
      schema: worktreeLsSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "WORKTREE_LIST_FAILED",
      message: `Failed to list worktrees: ${message}`,
    };
    throw error;
  }
}
