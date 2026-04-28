// Task environment variables — adapted from emdash's shared/task/envVars.ts

export interface TaskEnvContext {
  taskId: string;
  taskName: string;
  taskPath: string;
  projectPath: string;
  defaultBranch?: string;
  portSeed?: string;
}

/**
 * Generate a deterministic port from a seed string (for dev server ports etc.)
 */
function seedToPort(seed: string, base = 3100, range = 900): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return base + (Math.abs(hash) % range);
}

/**
 * Build environment variables for a task/worktree context.
 * These get injected into the agent's terminal session.
 */
export function getTaskEnvVars(ctx: TaskEnvContext): Record<string, string> {
  const env: Record<string, string> = {
    HUBCODE_TASK_ID: ctx.taskId,
    HUBCODE_TASK_NAME: ctx.taskName,
    HUBCODE_TASK_PATH: ctx.taskPath,
    HUBCODE_PROJECT_PATH: ctx.projectPath,
  };

  if (ctx.defaultBranch) {
    env.HUBCODE_DEFAULT_BRANCH = ctx.defaultBranch;
  }

  if (ctx.portSeed) {
    env.HUBCODE_DEV_PORT = String(seedToPort(ctx.portSeed));
  }

  return env;
}
