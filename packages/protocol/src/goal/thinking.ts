import type { GoalConfig, TaskSpec, UsageRole } from "./types.js";

/**
 * The provider value (`provider` or `provider/model`) an agent in this role runs on.
 * A worker uses its task's provider, else defaultProvider. The reviewer falls back
 * to the Lead's provider; the verifier to the reviewer's, then the Lead's.
 */
export function goalRoleProvider(
  config: GoalConfig,
  role: UsageRole,
  task?: Pick<TaskSpec, "provider">,
): string {
  switch (role) {
    case "lead":
      return config.leadProvider;
    case "worker":
      return task?.provider ?? config.defaultProvider;
    case "reviewer":
      return config.reviewProvider ?? config.leadProvider;
    case "verifier":
      return config.verifyProvider ?? config.reviewProvider ?? config.leadProvider;
  }
}

/**
 * The thinking option an agent in this role asks for, or undefined to leave the
 * model's default. Roles do not inherit each other's thinking: an id belongs to one
 * model, and the roles may run on different ones. workerThinking applies only to a
 * worker on defaultProvider, and a task's own `thinking` wins over it.
 */
export function goalRoleThinking(
  config: GoalConfig,
  role: UsageRole,
  task?: Pick<TaskSpec, "provider" | "thinking">,
): string | undefined {
  switch (role) {
    case "lead":
      return config.leadThinking;
    case "worker":
      if (task?.thinking) return task.thinking;
      return goalRoleProvider(config, "worker", task) === config.defaultProvider
        ? config.workerThinking
        : undefined;
    case "reviewer":
      return config.reviewThinking;
    case "verifier":
      return config.verifyThinking;
  }
}
