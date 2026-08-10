import type { Command } from "commander";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import {
  renderTable,
  type CommandOptions,
  type SingleResult,
  type OutputSchema,
  type CommandError,
} from "../../output/index.js";

/** Worktree list item for display */
export interface WorktreeListItem {
  name: string;
  branch: string;
  cwd: string;
  agent: string;
}

export interface WorktreeListOutput {
  inventoryScope: "current_registered_non_archived_git_projects";
  allManagedWorktreesIncluded: false;
  excludedProjectStates: ["archived", "removed"];
  worktrees: WorktreeListItem[];
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

const worktreeLsTableSchema: OutputSchema<WorktreeListItem> = {
  idField: "name",
  columns: [
    { header: "NAME", field: "name", width: 20 },
    { header: "BRANCH", field: "branch", width: 25 },
    { header: "CWD", field: "cwd", width: 45 },
    { header: "AGENT", field: "agent", width: 10 },
  ],
};

const WORKTREE_INVENTORY_SCOPE_TEXT =
  "Scope: current registered, non-archived Git projects only; this is not a complete inventory of all managed worktrees because archived or removed projects are excluded.";

/** Schema for worktree ls output */
export const worktreeLsSchema: OutputSchema<WorktreeListOutput> = {
  idField: (output) => output.worktrees.map((worktree) => worktree.name).join("\n"),
  columns: [],
  renderHuman: (result, options) => {
    const outputs = result.type === "single" ? [result.data] : result.data;
    const table = renderTable<WorktreeListItem>(
      {
        type: "list",
        data: outputs.flatMap((output) => output.worktrees),
        schema: worktreeLsTableSchema,
      },
      options,
    );
    return table ? `${WORKTREE_INVENTORY_SCOPE_TEXT}\n${table}` : WORKTREE_INVENTORY_SCOPE_TEXT;
  },
};

export type WorktreeLsResult = SingleResult<WorktreeListOutput>;

export interface WorktreeLsOptions extends CommandOptions {
  host?: string;
}

export async function runLsCommand(
  options: WorktreeLsOptions,
  _command: Command,
): Promise<WorktreeLsResult> {
  return runLsCommandWithDeps(options, { connectToDaemon });
}

export async function runLsCommandWithDeps(
  options: WorktreeLsOptions,
  deps: { connectToDaemon: typeof connectToDaemon },
): Promise<WorktreeLsResult> {
  const host = getDaemonHost({ host: options.host });

  let client: DaemonClient;
  try {
    client = await deps.connectToDaemon({ host: options.host });
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
    const agentsPayload = await client.fetchAgents({ filter: { includeArchived: true } });
    const agents = agentsPayload.entries.map((entry) => entry.agent);

    const response = await client.getPaseoWorktreeList({ allRegisteredProjects: true });

    await client.close();

    if (response.error) {
      const error: CommandError = {
        code: "WORKTREE_LIST_FAILED",
        message: `Failed to list worktrees: ${response.error.message}`,
      };
      throw error;
    }

    if (response.repositoryErrors !== undefined) {
      const error: CommandError = {
        code: "WORKTREE_LIST_PARTIAL",
        message: `Failed to list worktrees from ${response.repositoryErrors} registered ${response.repositoryErrors === 1 ? "repository" : "repositories"}`,
        details: "Resolve the unavailable repositories and retry.",
      };
      throw error;
    }

    // Build a map of worktree paths to agent IDs
    const worktreeAgentMap = new Map<string, string>();
    for (const agent of agents) {
      if (isAgentInManagedWorktree(agent.cwd)) {
        worktreeAgentMap.set(agent.cwd, agent.id.slice(0, 7));
      }
    }

    const items: WorktreeListItem[] = response.worktrees.map((wt) => ({
      name: extractWorktreeName(wt.worktreePath),
      branch: wt.branchName ?? "-",
      cwd: shortenPath(wt.worktreePath),
      agent: worktreeAgentMap.get(wt.worktreePath) ?? "-",
    }));

    return {
      type: "single",
      data: {
        inventoryScope: "current_registered_non_archived_git_projects",
        allManagedWorktreesIncluded: false,
        excludedProjectStates: ["archived", "removed"],
        worktrees: items,
      },
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
