import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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

function isMissingPathFsError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  // ENOENT: path missing. ENOTDIR: a path component is not a directory (also
  // unusable as a worktree cwd).
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function pathIsExistingDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch (error) {
    if (isMissingPathFsError(error)) {
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
    if (isMissingPathFsError(error)) {
      throw new MissingAgentCwdError(agentId, absoluteCwd);
    }
    throw error;
  }
}

/**
 * Sync twin of pathIsExistingDirectory for run-path guards that must not start
 * provider work when the recorded worktree is gone.
 */
export function pathIsExistingDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isMissingPathFsError(error)) {
      return false;
    }
    throw error;
  }
}

/** Sync twin of assertAgentCwdExists for AgentManager run entrypoints. */
export function assertAgentCwdExistsSync(agentId: string, cwd: string): void {
  const absoluteCwd = resolve(cwd);
  if (!pathIsExistingDirectorySync(absoluteCwd)) {
    throw new MissingAgentCwdError(agentId, absoluteCwd);
  }
}

/**
 * Existing directory used only as the provider launch cwd when recovering
 * timeline/logs for an agent whose recorded worktree is gone. Must never be
 * written back as the managed/stored agent cwd.
 */
export function resolveSafeReadRecoveryCwd(): string {
  const candidate = resolve(tmpdir());
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return candidate;
  }
  // Extremely defensive: process.cwd() is expected to exist for the daemon.
  return resolve(process.cwd());
}
