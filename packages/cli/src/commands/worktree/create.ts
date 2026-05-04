import path from "node:path";
import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/server";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

export interface WorktreeCreateResult {
  name: string;
  branchName: string;
  worktreePath: string;
}

export const createSchema: OutputSchema<WorktreeCreateResult> = {
  idField: "worktreePath",
  columns: [
    { header: "NAME", field: "name", width: 24 },
    { header: "BRANCH", field: "branchName", width: 28 },
    { header: "PATH", field: "worktreePath", width: 50 },
  ],
};

export interface WorktreeCreateOptions extends CommandOptions {
  host?: string;
  cwd?: string;
  mode?: string;
  newBranch?: string;
  base?: string;
  branch?: string;
  prNumber?: string;
}

export type WorktreeCreateTarget =
  | { mode: "branch-off"; newBranch: string; base?: string }
  | { mode: "checkout-branch"; branch: string }
  | { mode: "checkout-pr"; prNumber: number };

export interface ParsedWorktreeCreateInput {
  cwd: string;
  target: WorktreeCreateTarget;
}

const VALID_MODES = ["branch-off", "checkout-branch", "checkout-pr"] as const;

export function buildCreateWorktreeInput(
  options: WorktreeCreateOptions,
  cwd: string,
): ParsedWorktreeCreateInput {
  const mode = options.mode;
  if (!mode) {
    throw cmdError(
      "MISSING_MODE",
      "--mode is required",
      `Expected one of: ${VALID_MODES.join(", ")}`,
    );
  }

  switch (mode) {
    case "branch-off": {
      if (!options.newBranch) {
        throw cmdError("MISSING_NEW_BRANCH", "--new-branch is required for --mode branch-off");
      }
      return {
        cwd,
        target: {
          mode: "branch-off",
          newBranch: options.newBranch,
          ...(options.base ? { base: options.base } : {}),
        },
      };
    }
    case "checkout-branch": {
      if (!options.branch) {
        throw cmdError("MISSING_BRANCH", "--branch is required for --mode checkout-branch");
      }
      return { cwd, target: { mode: "checkout-branch", branch: options.branch } };
    }
    case "checkout-pr": {
      if (options.prNumber === undefined || options.prNumber === "") {
        throw cmdError("MISSING_PR_NUMBER", "--pr-number is required for --mode checkout-pr");
      }
      const parsed = Number(options.prNumber);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw cmdError(
          "INVALID_PR_NUMBER",
          `Invalid --pr-number: ${options.prNumber}`,
          "Expected a positive integer",
        );
      }
      return { cwd, target: { mode: "checkout-pr", prNumber: parsed } };
    }
    default:
      throw cmdError(
        "INVALID_MODE",
        `Invalid --mode: ${mode}`,
        `Expected one of: ${VALID_MODES.join(", ")}`,
      );
  }
}

export function toDaemonCreateInput(parsed: ParsedWorktreeCreateInput) {
  switch (parsed.target.mode) {
    case "branch-off":
      return {
        cwd: parsed.cwd,
        worktreeSlug: parsed.target.newBranch,
        action: "branch-off" as const,
        ...(parsed.target.base ? { refName: parsed.target.base } : {}),
      };
    case "checkout-branch":
      return {
        cwd: parsed.cwd,
        action: "checkout" as const,
        refName: parsed.target.branch,
      };
    case "checkout-pr":
      return {
        cwd: parsed.cwd,
        action: "checkout" as const,
        githubPrNumber: parsed.target.prNumber,
      };
  }
}

function cmdError(code: string, message: string, details?: string): CommandError {
  return details ? { code, message, details } : { code, message };
}

export async function runCreateCommand(
  options: WorktreeCreateOptions,
  _command: Command,
): Promise<SingleResult<WorktreeCreateResult>> {
  const cwd = options.cwd ?? process.cwd();
  const parsed = buildCreateWorktreeInput(options, cwd);

  const host = getDaemonHost({ host: options.host });
  let client: DaemonClient;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw cmdError(
      "DAEMON_NOT_RUNNING",
      `Cannot connect to daemon at ${host}: ${message}`,
      "Start the daemon with: paseo daemon start",
    );
  }

  try {
    const response = await client.createPaseoWorktree(toDaemonCreateInput(parsed));

    const workspace = response.workspace;
    if (!workspace || response.error) {
      throw cmdError(
        "WORKTREE_CREATE_FAILED",
        `Failed to create worktree: ${response.error ?? "no workspace returned"}`,
      );
    }

    const worktreePath = workspace.workspaceDirectory ?? workspace.id;

    return {
      type: "single",
      data: {
        name: path.basename(worktreePath),
        branchName: workspace.name,
        worktreePath,
      },
      schema: createSchema,
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw cmdError("WORKTREE_CREATE_FAILED", `Failed to create worktree: ${message}`);
  } finally {
    await client.close().catch(() => {});
  }
}
