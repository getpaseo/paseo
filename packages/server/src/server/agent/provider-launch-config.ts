import { z } from "zod";

import { isCommandAvailable } from "../../utils/executable.js";
import type { AgentProvider } from "./agent-sdk-types.js";
import { AgentProviderSchema } from "./provider-manifest.js";

const ProviderCommandDefaultSchema = z
  .object({
    mode: z.literal("default"),
  })
  .strict();

const ProviderCommandAppendSchema = z
  .object({
    mode: z.literal("append"),
    args: z.array(z.string()).optional(),
  })
  .strict();

const ProviderCommandReplaceSchema = z
  .object({
    mode: z.literal("replace"),
    argv: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const ProviderCommandSchema = z.discriminatedUnion("mode", [
  ProviderCommandDefaultSchema,
  ProviderCommandAppendSchema,
  ProviderCommandReplaceSchema,
]);

export const ProviderRuntimeSettingsSchema = z
  .object({
    command: ProviderCommandSchema.optional(),
    env: z.record(z.string()).optional(),
    modelMap: z.record(z.string()).optional(),
  })
  .strict();

export const AgentProviderRuntimeSettingsMapSchema = z.record(
  AgentProviderSchema,
  ProviderRuntimeSettingsSchema,
);

export type ProviderCommand = z.infer<typeof ProviderCommandSchema>;
export type ProviderRuntimeSettings = z.infer<typeof ProviderRuntimeSettingsSchema>;
export type AgentProviderRuntimeSettingsMap = Partial<
  Record<AgentProvider, ProviderRuntimeSettings>
>;

export type ProviderCommandPrefix = {
  command: string;
  args: string[];
};

export async function resolveProviderCommandPrefix(
  commandConfig: ProviderCommand | undefined,
  resolveDefaultCommand: () => string | Promise<string>,
): Promise<ProviderCommandPrefix> {
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: await resolveDefaultCommand(),
      args: [],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: await resolveDefaultCommand(),
      args: [...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0]!,
    args: commandConfig.argv.slice(1),
  };
}

// Env vars that indicate a running Claude Code session. If the daemon itself is
// launched from inside Claude Code (e.g. by a Paseo agent), these leak into
// child processes and cause "cannot be launched inside another session" errors.
const PARENT_SESSION_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
];

export function applyProviderEnv(
  baseEnv: Record<string, string | undefined>,
  runtimeSettings?: ProviderRuntimeSettings,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {
    ...baseEnv,
    ...(runtimeSettings?.env ?? {}),
  };
  for (const key of PARENT_SESSION_ENV_VARS) {
    delete merged[key];
  }
  return merged;
}

export function resolveModelViaMap(
  modelId: string | null | undefined,
  modelMap: Record<string, string> | undefined,
): string | null | undefined {
  if (!modelId || !modelMap) {
    return modelId;
  }
  return modelMap[modelId] ?? modelId;
}

export function reverseResolveModelViaMap(
  runtimeModel: string,
  modelMap: Record<string, string> | undefined,
): string | null {
  if (!modelMap) {
    return null;
  }
  for (const [paseoId, mappedId] of Object.entries(modelMap)) {
    if (mappedId === runtimeModel) {
      return paseoId;
    }
  }
  return null;
}

export async function isProviderCommandAvailable(
  commandConfig: ProviderCommand | undefined,
  resolveDefaultCommand: () => string | Promise<string>,
): Promise<boolean> {
  try {
    const prefix = await resolveProviderCommandPrefix(commandConfig, resolveDefaultCommand);
    return isCommandAvailable(prefix.command);
  } catch {
    return false;
  }
}
