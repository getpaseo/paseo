import path from "path";
import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { resolveWorktreeRepositoryIdentity } from "./repository-identity.js";

/** Result type for worktree archive command */
export interface WorktreeArchiveResult {
  name: string;
  status: "archived";
  removedAgents: string[];
}

/** Schema for archive command output */
export const archiveSchema: OutputSchema<WorktreeArchiveResult> = {
  idField: "name",
  columns: [
    { header: "NAME", field: "name" },
    { header: "STATUS", field: "status" },
    {
      header: "REMOVED AGENTS",
      field: (item) => (item.removedAgents.length > 0 ? item.removedAgents.join(", ") : "-"),
    },
  ],
};

export interface WorktreeArchiveOptions extends CommandOptions {
  host?: string;
  project?: string;
  repoRoot?: string;
}

export type WorktreeArchiveCommandResult = SingleResult<WorktreeArchiveResult>;

export async function runArchiveCommand(
  nameArg: string,
  options: WorktreeArchiveOptions,
  _command: Command,
): Promise<WorktreeArchiveCommandResult> {
  return runArchiveCommandWithDeps(nameArg, options, { connectToDaemon });
}

export async function runArchiveCommandWithDeps(
  nameArg: string,
  options: WorktreeArchiveOptions,
  deps: { connectToDaemon: typeof connectToDaemon; cwd?: string },
): Promise<WorktreeArchiveCommandResult> {
  // Validate arguments
  if (!nameArg || nameArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_WORKTREE_NAME",
      message: "Worktree name is required",
      details: "Usage: paseo worktree archive <name>",
    };
    throw error;
  }

  let client: DaemonClient;
  try {
    client = await deps.connectToDaemon({ host: options.host });
  } catch (err) {
    const host = getDaemonHost({ host: options.host });
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }

  try {
    const identity = await resolveWorktreeRepositoryIdentity(options, client, deps.cwd);
    // Get the list of worktrees first to resolve the name
    const listResponse = await client.getPaseoWorktreeList(identity);

    if (listResponse.error) {
      const error: CommandError = {
        code: "WORKTREE_LIST_FAILED",
        message: `Failed to list worktrees: ${listResponse.error.message}`,
      };
      throw error;
    }

    // Resolve to one backing path. A branch and a directory can share a name,
    // and pending cleanup placements can outlive Git's worktree entry.
    const matchingWorktrees = listResponse.worktrees.filter((wt) => {
      const name = path.basename(wt.worktreePath);
      return name === nameArg || wt.branchName === nameArg;
    });
    const worktreesByPath = new Map<string, (typeof matchingWorktrees)[number]>();
    for (const candidate of matchingWorktrees) {
      if (!worktreesByPath.has(candidate.worktreePath)) {
        worktreesByPath.set(candidate.worktreePath, candidate);
      }
    }
    const matches = [...worktreesByPath.values()];
    if (matches.length > 1) {
      const error: CommandError = {
        code: "AMBIGUOUS_WORKTREE",
        message: `Worktree name or branch is ambiguous: ${nameArg}`,
        details: matches.map((candidate) => candidate.worktreePath).join(", "),
      };
      throw error;
    }
    const worktree = matches[0];

    if (!worktree) {
      const error: CommandError = {
        code: "WORKTREE_NOT_FOUND",
        message: `Worktree not found: ${nameArg}`,
        details: 'Use "paseo worktree ls" to list available worktrees',
      };
      throw error;
    }

    // Archive the worktree. scope:"worktree" archives every active workspace on
    // the directory and then removes the directory (Paseo-owned gated).
    const response = await client.archivePaseoWorktree({
      worktreePath: worktree.worktreePath,
      ...identity,
      branchName: worktree.branchName ?? undefined,
      scope: "worktree",
    });

    await client.close();

    if (response.error) {
      const error: CommandError = {
        code: "WORKTREE_ARCHIVE_FAILED",
        message: `Failed to archive worktree: ${response.error.message}`,
      };
      throw error;
    }

    const worktreeName = path.basename(worktree.worktreePath) || nameArg;

    return {
      type: "single",
      data: {
        name: worktreeName,
        status: "archived",
        removedAgents: response.removedAgents ?? [],
      },
      schema: archiveSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "WORKTREE_ARCHIVE_FAILED",
      message: `Failed to archive worktree: ${message}`,
    };
    throw error;
  }
}
