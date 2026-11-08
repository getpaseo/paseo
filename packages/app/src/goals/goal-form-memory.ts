import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import type { GoalFormPrefill } from "./goal-form-model";
import type { GoalSettings } from "./goal-settings";

/** What the form remembers from your last managed goal on a host. */
export interface GoalFormMemory {
  cwd: string;
  leadProvider: string;
  defaultProvider: string;
  reviewProvider: string | null;
  testCommand: string | null;
  allowedProviders: string[];
  settings: GoalSettings;
  /**
   * Thinking ids per role. Absent from memory written before thinking existed. A level the
   * role's model no longer lists is dropped once the providers load.
   */
  thinking?: GoalFormMemoryThinking;
}

export interface GoalFormMemoryThinking {
  lead?: string;
  worker?: string;
  reviewer?: string;
  verifier?: string;
}

function thinkingFromConfig(config: GoalConfig): GoalFormMemoryThinking | undefined {
  const thinking: GoalFormMemoryThinking = {
    ...(config.leadThinking ? { lead: config.leadThinking } : {}),
    ...(config.workerThinking ? { worker: config.workerThinking } : {}),
    ...(config.reviewThinking ? { reviewer: config.reviewThinking } : {}),
    ...(config.verifyThinking ? { verifier: config.verifyThinking } : {}),
  };
  return Object.keys(thinking).length > 0 ? thinking : undefined;
}

export function goalFormMemoryFromConfig(
  config: GoalConfig,
  settings: GoalSettings,
): GoalFormMemory {
  const thinking = thinkingFromConfig(config);
  return {
    cwd: config.cwd,
    leadProvider: config.leadProvider,
    defaultProvider: config.defaultProvider,
    reviewProvider: config.reviewProvider ?? null,
    testCommand: config.testCommand ?? null,
    allowedProviders: config.allowedProviders ?? [],
    settings,
    ...(thinking ? { thinking } : {}),
  };
}

/**
 * Version 2 changed what a remembered `fail` means. Until then `fail` was the form's default,
 * so memory written by version 1 holds it whether or not you chose it; it is read as the new
 * default, `wait`. A `fail` you choose now is remembered as such.
 */
export const GOAL_FORM_MEMORY_VERSION = 2;

export function migrateGoalFormMemory(
  byServer: Readonly<Record<string, GoalFormMemory>>,
  fromVersion: number,
): Record<string, GoalFormMemory> {
  if (fromVersion >= 2) {
    return { ...byServer };
  }
  return Object.fromEntries(
    Object.entries(byServer).map(([serverId, memory]) => [
      serverId,
      memory.settings.onPermissionRequest === "fail"
        ? { ...memory, settings: { ...memory.settings, onPermissionRequest: "wait" as const } }
        : memory,
    ]),
  );
}

/**
 * Seeds a new goal from your last one. The directory you are working in wins over the
 * remembered one, and the test command comes along only for the same directory, since it
 * belongs to that project.
 */
export function prefillFromGoalFormMemory(
  memory: GoalFormMemory | null,
  context: { cwd?: string },
): GoalFormPrefill {
  if (!memory) {
    return context.cwd ? { managed: true, cwd: context.cwd } : { managed: true };
  }
  const cwd = context.cwd ?? memory.cwd;
  return {
    managed: true,
    cwd,
    leadProvider: memory.leadProvider,
    defaultProvider: memory.defaultProvider,
    ...(memory.reviewProvider ? { reviewProvider: memory.reviewProvider } : {}),
    ...(memory.testCommand && cwd === memory.cwd ? { testCommand: memory.testCommand } : {}),
    ...(memory.allowedProviders.length > 0 ? { allowedProviders: memory.allowedProviders } : {}),
    ...(memory.thinking?.lead ? { leadThinking: memory.thinking.lead } : {}),
    ...(memory.thinking?.worker ? { workerThinking: memory.thinking.worker } : {}),
    ...(memory.thinking?.reviewer ? { reviewThinking: memory.thinking.reviewer } : {}),
    ...(memory.thinking?.verifier ? { verifyThinking: memory.thinking.verifier } : {}),
  };
}
