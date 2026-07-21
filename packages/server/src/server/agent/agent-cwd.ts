import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export const MISSING_AGENT_CWD_ERROR_CODE = "AGENT_CWD_MISSING" as const;

/**
 * Structured, actionable error when an existing agent still has a record but
 * its recorded working directory/worktree has been deleted. Callers must not
 * collapse this into generic "Agent not found".
 */
export class MissingAgentCwdError extends Error {
  readonly code = MISSING_AGENT_CWD_ERROR_CODE;
  readonly agentId: string;
  readonly cwd: string;

  constructor(agentId: string, cwd: string) {
    const absoluteCwd = resolve(cwd);
    super(
      [
        `Agent ${agentId} exists but its working directory is missing: ${absoluteCwd}.`,
        "Recreate the worktree or rebind the agent cwd, then retry send/continue.",
        "Timeline/logs can still be read when durable or in-memory history is available.",
      ].join(" "),
    );
    this.name = "MissingAgentCwdError";
    this.agentId = agentId;
    this.cwd = absoluteCwd;
  }
}

export function isMissingAgentCwdError(error: unknown): error is MissingAgentCwdError {
  return (
    error instanceof MissingAgentCwdError ||
    (error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === MISSING_AGENT_CWD_ERROR_CODE)
  );
}

export async function pathIsExistingDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

/** Throws MissingAgentCwdError when the agent cwd is gone; preserves other fs errors. */
export async function assertAgentCwdExists(agentId: string, cwd: string): Promise<void> {
  const absoluteCwd = resolve(cwd);
  try {
    const stats = await stat(absoluteCwd);
    if (!stats.isDirectory()) {
      throw new MissingAgentCwdError(agentId, absoluteCwd);
    }
  } catch (error) {
    if (isMissingAgentCwdError(error)) {
      throw error;
    }
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new MissingAgentCwdError(agentId, absoluteCwd);
    }
    throw error;
  }
}
