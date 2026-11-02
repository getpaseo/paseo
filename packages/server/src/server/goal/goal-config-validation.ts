import { goalPermissionPolicy } from "@getpaseo/protocol/goal/config-bounds";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import { goalRoleProvider } from "@getpaseo/protocol/goal/thinking";
import type { GitPort } from "./git-ops.js";
import { assertThinkingOption, type GoalModelCatalog } from "./goal-thinking.js";

/** Returns the config to store: the one given, with the base commit filled in. */
export type GoalConfigValidator = (config: GoalConfig) => Promise<GoalConfig>;

/** Checks a goal's changed settings; throws when they cannot be stored. */
export type GoalConfigUpdateValidator = (next: GoalConfig, previous: GoalConfig) => Promise<void>;

/** A permission mode a provider lists; `isUnattended` marks its no-prompt mode. */
export interface GoalMode {
  id: string;
  isUnattended?: boolean;
}

/** The permission modes a provider lists for a directory. */
export type GoalModeCatalog = (provider: string, cwd: string) => Promise<GoalMode[]>;

/**
 * The auto modes the `auto` policy may pick, per provider, most autonomous first. Only a
 * mode that lets a classifier or reviewer answer prompts counts: Codex's `auto` mode is
 * "Default Permissions" and asks for every command, so Codex needs `auto-review`. A provider
 * not listed here uses a mode with the id `auto`.
 */
const GOAL_AUTO_MODES: Record<string, readonly string[]> = {
  claude: ["auto"],
  codex: ["auto-review"],
};
const GOAL_AUTO_MODES_FALLBACK: readonly string[] = ["auto"];

/** The mode the `auto` policy picks from a provider's modes, if it lists one. */
export function goalAutoModeId(provider: string, modes: GoalMode[]): string | undefined {
  const preferred = GOAL_AUTO_MODES[baseProvider(provider)] ?? GOAL_AUTO_MODES_FALLBACK;
  return preferred.find((id) => modes.some((mode) => mode.id === id));
}

export interface ConfigValidationDeps {
  git: Pick<GitPort, "head" | "resolveCommit">;
  /** Provider ids the daemon has registered. */
  knownProviders: () => string[];
  /**
   * Model catalog the thinking settings are checked against. Without it, or when it
   * cannot be read, thinking ids are accepted and the provider decides.
   */
  modelCatalog?: GoalModelCatalog;
  /**
   * Mode catalog the `auto` permission policy is checked against. Without it, or when it
   * cannot be read, `auto` is accepted and an agent whose provider lists no auto mode
   * starts in its default mode, as under `wait`.
   */
  modeCatalog?: GoalModeCatalog;
  /** Current time in epoch milliseconds; tests supply their own. */
  now?: () => number;
}

const baseProvider = (provider: string): string => provider.split("/")[0] ?? provider;

/**
 * Catches a bad goal configuration when the goal is created, rather than minutes
 * later when an agent first fails to start.
 */
export function createGoalConfigValidator(deps: ConfigValidationDeps): GoalConfigValidator {
  return async (config) => {
    const used = [
      ["leadProvider", config.leadProvider],
      ["defaultProvider", config.defaultProvider],
      ...(config.reviewProvider ? [["reviewProvider", config.reviewProvider]] : []),
      ...(config.verifyProvider ? [["verifyProvider", config.verifyProvider]] : []),
    ] as const;
    assertDeadline(config, deps);
    const known = deps.knownProviders();
    for (const [field, provider] of used) {
      if (!known.includes(baseProvider(provider))) {
        throw new Error(
          `${field} "${provider}" is not a registered provider. Available: ${known.join(", ") || "(none)"}`,
        );
      }
      if (config.allowedProviders && !config.allowedProviders.includes(baseProvider(provider))) {
        throw new Error(`${field} "${provider}" is not in allowedProviders`);
      }
    }
    let head: string;
    try {
      head = await deps.git.head(config.cwd);
    } catch {
      throw new Error(`cwd "${config.cwd}" is not a git repository`);
    }
    // A given base is stored as the full id it names now, so later reads cannot drift.
    let baseCommit = head;
    if (config.baseCommit !== undefined) {
      const resolved = await deps.git.resolveCommit(config.cwd, config.baseCommit);
      if (!resolved) {
        throw new Error(
          `baseCommit "${config.baseCommit}" is not a commit in the repository at "${config.cwd}". ` +
            "Give a commit id of at least 7 hex digits that exists there, or leave baseCommit out to start from its HEAD.",
        );
      }
      baseCommit = resolved;
    }
    const thinking = [
      ["leadThinking", "lead", config.leadThinking],
      ["workerThinking", "worker", config.workerThinking],
      ["reviewThinking", "reviewer", config.reviewThinking],
      ["verifyThinking", "verifier", config.verifyThinking],
    ] as const;
    for (const [field, role, value] of thinking) {
      if (value === undefined) continue;
      await assertThinkingOption({
        catalog: deps.modelCatalog,
        providerValue: goalRoleProvider(config, role),
        thinking: value,
        cwd: config.cwd,
        field,
      });
    }
    await assertAutoPolicy(config, deps);
    return { ...config, baseCommit };
  };
}

/**
 * Checks changed settings as goal creation checks them: the deadline when it changed, and
 * the `auto` policy when it was chosen. Bounds are checked by the schema.
 */
export function createGoalConfigUpdateValidator(
  deps: Pick<ConfigValidationDeps, "modeCatalog" | "now">,
): GoalConfigUpdateValidator {
  return async (next, previous) => {
    if (next.limits?.deadlineAt !== previous.limits?.deadlineAt) assertDeadline(next, deps);
    if (goalPermissionPolicy(next) !== goalPermissionPolicy(previous)) {
      await assertAutoPolicy(next, deps);
    }
  };
}

function assertDeadline(config: GoalConfig, deps: Pick<ConfigValidationDeps, "now">): void {
  const deadlineAt = config.limits?.deadlineAt;
  if (deadlineAt === undefined) return;
  const at = Date.parse(deadlineAt);
  if (Number.isNaN(at)) throw new Error(`limits.deadlineAt "${deadlineAt}" is not a date`);
  if (at <= (deps.now ?? Date.now)()) {
    throw new Error(`limits.deadlineAt "${deadlineAt}" is in the past`);
  }
}

/**
 * Under `auto`, every role provider must list an auto mode. A provider whose catalog
 * cannot be read is accepted; a task's own provider is not known until the plan, and an
 * agent on a provider without an auto mode starts in its default mode instead.
 */
async function assertAutoPolicy(
  config: GoalConfig,
  deps: Pick<ConfigValidationDeps, "modeCatalog">,
): Promise<void> {
  if (goalPermissionPolicy(config) !== "auto" || !deps.modeCatalog) return;
  const roles = [
    ["leadProvider", config.leadProvider],
    ["defaultProvider", config.defaultProvider],
    ["reviewProvider", config.reviewProvider],
    ["verifyProvider", config.verifyProvider],
  ] as const;
  const checked = new Set<string>();
  for (const [field, value] of roles) {
    if (!value) continue;
    const provider = baseProvider(value);
    if (checked.has(provider)) continue;
    checked.add(provider);
    let modes: GoalMode[];
    try {
      modes = await deps.modeCatalog(provider, config.cwd);
    } catch {
      continue;
    }
    if (goalAutoModeId(provider, modes)) continue;
    throw new Error(
      `onPermissionRequest "auto" needs an auto mode, and ${field} "${value}" has none. ` +
        `Available modes: ${modes.map((mode) => mode.id).join(", ") || "(none)"}. Use "wait" instead.`,
    );
  }
}
