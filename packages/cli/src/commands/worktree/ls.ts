import type { Command } from "commander";
import { basename } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema, CommandError } from "../../output/index.js";
import { resolveWorktreeRepositoryIdentity } from "./repository-identity.js";

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
  project?: string;
  repoRoot?: string;
}

export async function runLsCommand(
  options: WorktreeLsOptions,
  command: Command,
): Promise<WorktreeLsResult> {
  return runLsCommandWithDeps(options, command, { connectToDaemon });
}

export async function runLsCommandWithDeps(
  options: WorktreeLsOptions,
  _command: Command,
  deps: { connectToDaemon: typeof connectToDaemon; cwd?: string },
): Promise<WorktreeLsResult> {
  let client: DaemonClient;
  try {
    client = await deps.connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${getDaemonHost({ host: options.host })}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }

  try {
    const agentsPayload = await client.fetchAgents({ filter: { includeArchived: true } });
    // Get worktree list from daemon
    const identity = await resolveWorktreeRepositoryIdentity(options, client, deps.cwd);
    const response = await client.getPaseoWorktreeList(identity);

    await client.close();

    if (response.error) {
      const error: CommandError = {
        code: "WORKTREE_LIST_FAILED",
        message: `Failed to list worktrees: ${response.error.message}`,
      };
      throw error;
    }

    // Build a map of worktree paths to agent IDs
    const worktreeAgentMap = new Map<string, string>();
    for (const entry of agentsPayload.entries) {
      const worktreeRoot = entry.project.checkout.worktreeRoot;
      if (worktreeRoot) {
        worktreeAgentMap.set(worktreeRoot, entry.agent.id.slice(0, 7));
      }
    }

    const items: WorktreeListItem[] = response.worktrees.map((wt) => ({
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
