import { realpath } from "node:fs/promises";
import type { Logger } from "pino";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import {
  isPaseoOwnedWorktreeCwd,
  resolveWorktreeRuntimeEnv,
  type WorktreeRootOptions,
} from "../utils/worktree.js";

export interface RestoredWorktreeEnvOptions extends WorktreeRootOptions {
  manager: Pick<TerminalManager, "registerCwdEnv">;
  logger: Logger;
}

// Worktree setup registers PASEO_WORKTREE_PATH, PASEO_WORKTREE_PORT and the source
// checkout path on the terminal manager, in memory only. Terminals restored after a
// restart need it registered again before they spawn. The port comes from the
// worktree metadata, so it matches what the original tab saw.
export function createRestoredWorktreeEnv(
  options: RestoredWorktreeEnvOptions,
): (workspaceCwd: string) => Promise<void> {
  const registered = new Map<string, Promise<void>>();

  async function register(workspaceCwd: string): Promise<void> {
    try {
      const ownership = await isPaseoOwnedWorktreeCwd(workspaceCwd, {
        ...(options.paseoHome ? { paseoHome: options.paseoHome } : {}),
        ...(options.worktreesRoot ? { worktreesRoot: options.worktreesRoot } : {}),
      });
      if (!ownership.allowed || !ownership.worktreePath) return;
      const env = await resolveWorktreeRuntimeEnv({
        // Worktree creation reports the resolved path; match it.
        worktreePath: await realpath(ownership.worktreePath),
        ...(ownership.repoRoot ? { repoRootPath: ownership.repoRoot } : {}),
      });
      options.manager.registerCwdEnv({ cwd: workspaceCwd, env });
    } catch (error) {
      options.logger.warn(
        { err: error, workspaceCwd },
        "Failed to rebuild worktree env for restored terminals",
      );
    }
  }

  return (workspaceCwd) => {
    let pending = registered.get(workspaceCwd);
    if (!pending) {
      pending = register(workspaceCwd);
      registered.set(workspaceCwd, pending);
    }
    return pending;
  };
}
