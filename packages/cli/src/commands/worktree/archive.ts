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
  cwd?: string;
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
  deps: { connectToDaemon: typeof connectToDaemon },
): Promise<WorktreeArchiveCommandResult> {
  const host = getDaemonHost({ host: options.host });

  // Validate arguments
  if (!nameArg || nameArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_WORKTREE_NAME",
      message: "Worktree name is required",
      details: "Usage: paseo worktree archive <name>",
    };
    throw error;
  }

  if (!options.cwd && !options.repoRoot) {
    const error: CommandError = {
      code: "MISSING_WORKTREE_SELECTOR",
      message: "Archive requires --cwd or --repo-root",
      details: "Use --repo-root <path> or --cwd <path> to select one repository.",
    };
    throw error;
  }

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
    // Get the list of worktrees first to resolve the name
    const listResponse = await client.getPaseoWorktreeList({
      cwd: options.cwd,
      repoRoot: options.repoRoot,
    });

    if (listResponse.error) {
      const error: CommandError = {
        code: "WORKTREE_LIST_FAILED",
        message: `Failed to list worktrees: ${listResponse.error.message}`,
      };
      throw error;
    }

    // Find the worktree by name or branch
    const matches = listResponse.worktrees.filter((wt) => {
      const name = path.basename(wt.worktreePath);
      return name === nameArg || wt.branchName === nameArg;
    });
    if (matches.length > 1) {
      const identities = matches.map(
        (worktree) => `${worktree.worktreePath} (branch: ${worktree.branchName ?? "-"})`,
      );
      const error: CommandError = {
        code: "WORKTREE_AMBIGUOUS",
        message: `Multiple worktrees match: ${nameArg}`,
        details: [
          ...identities,
          "Use --repo-root <path> or --cwd <path> to select one repository.",
        ].join("\n"),
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
      repoRoot: options.repoRoot ?? options.cwd,
      expectedWorktreeIdentity: nameArg,
      expectedWorktreePath: worktree.worktreePath,
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
