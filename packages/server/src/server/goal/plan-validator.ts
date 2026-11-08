import type { Goal, TaskSpec } from "@getpaseo/protocol/goal/types";
import { goalRoleProvider } from "@getpaseo/protocol/goal/thinking";
import { GoalThinkingError, assertThinkingOption, type GoalModelCatalog } from "./goal-thinking.js";
import { PlanRevisionError } from "./plan-revision.js";

export interface PlanValidatorDeps {
  /** Provider ids a plan may name. */
  knownProviders(): string[];
  /** Model catalog a plan's thinking ids are checked against; absent accepts them. */
  modelCatalog?: GoalModelCatalog;
}

/**
 * The checks on task specs that need the daemon's provider registry, which the reducer has no
 * access to: providers within the registered set and the goal's allow-list, and thinking ids
 * the task's model lists. Used for the Lead's first plan and for every revision.
 */
export class PlanValidator {
  constructor(private readonly deps: PlanValidatorDeps) {}

  /** Providers a plan may name: the registered ones, narrowed by the goal's allow-list. */
  providersFor(goal: Goal): string[] {
    const allowed = goal.config?.allowedProviders;
    const known = this.deps.knownProviders();
    return allowed ? known.filter((p) => allowed.includes(p)) : known;
  }

  /** A task's thinking id must be one its model lists, when the catalog knows the model. */
  async checkThinking(goal: Goal, tasks: readonly TaskSpec[]): Promise<void> {
    if (!goal.config) return;
    for (const task of tasks) {
      if (!task.thinking) continue;
      await assertThinkingOption({
        catalog: this.deps.modelCatalog,
        providerValue: goalRoleProvider(goal.config, "worker", task),
        thinking: task.thinking,
        cwd: goal.config.cwd,
        field: `Task ${task.id} thinking`,
      });
    }
  }

  /** Checks the specs a revision adds or replaces. Throws PlanRevisionError. */
  async check(goal: Goal, specs: readonly TaskSpec[]): Promise<void> {
    const providers = this.providersFor(goal);
    for (const spec of specs) {
      const provider = spec.provider?.split("/")[0];
      if (provider && !providers.includes(provider)) {
        throw new PlanRevisionError(
          `Task ${spec.id} names unknown provider "${provider}". Use one of: ${providers.join(", ")}, or omit provider.`,
        );
      }
    }
    try {
      await this.checkThinking(goal, specs);
    } catch (error) {
      if (error instanceof GoalThinkingError) throw new PlanRevisionError(error.message);
      throw error;
    }
  }
}
