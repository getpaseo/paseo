import path from "node:path";
import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";
import { buildCreateWorktreeRequest, type WorktreeCreateOptions } from "./create-input.js";

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

function cmdError(code: string, message: string, details?: string): CommandError {
  return details ? { code, message, details } : { code, message };
}

export async function runCreateCommand(
  options: WorktreeCreateOptions,
  _command: Command,
): Promise<SingleResult<WorktreeCreateResult>> {
  const cwd = options.cwd ?? process.cwd();
  const request = buildCreateWorktreeRequest(options, cwd);

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const response = await client.createPaseoWorktree(request);

    const workspace = response.workspace;
    if (!workspace || response.error) {
      throw cmdError(
        "WORKTREE_CREATE_FAILED",
        `Failed to create worktree: ${response.error ?? "no workspace returned"}`,
      );
    }

    if (!workspace.workspaceDirectory) {
      throw cmdError(
        "WORKTREE_CREATE_FAILED",
        "Failed to create worktree: workspace directory missing from daemon response",
      );
    }
    const worktreePath = workspace.workspaceDirectory;

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
