import { z } from "zod";

import { isAbsolute } from "node:path";
import { executableExists, findExecutable } from "../../utils/executable.js";
import { createExternalProcessEnv, type ProcessEnvRecord } from "../paseo-env.js";
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
    disallowedTools: z.array(z.string()).optional(),
  })
  .strict();

const ProviderProfileThinkingOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const ProviderProfileModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    thinkingOptions: z.array(ProviderProfileThinkingOptionSchema).optional(),
  })
  .strict();

export const ProviderOverrideSchema = z
  .object({
    extends: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    command: z.array(z.string().min(1)).min(1).optional(),
    env: z.record(z.string()).optional(),
    models: z.array(ProviderProfileModelSchema).optional(),
    additionalModels: z.array(ProviderProfileModelSchema).optional(),
    disallowedTools: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    order: z.number().optional(),
  })
  .strict();

export const AgentProviderRuntimeSettingsMapSchema = z.record(
  AgentProviderSchema,
  ProviderRuntimeSettingsSchema,
);

export type ProviderCommand = z.infer<typeof ProviderCommandSchema>;
export type ProviderRuntimeSettings = z.infer<typeof ProviderRuntimeSettingsSchema>;
export type ProviderProfileModel = z.infer<typeof ProviderProfileModelSchema>;
export type ProviderOverride = z.infer<typeof ProviderOverrideSchema>;
export type AgentProviderRuntimeSettingsMap = Partial<
  Record<AgentProvider, ProviderRuntimeSettings>
>;

export interface ProviderCommandPrefix {
  command: string;
  args: string[];
}

export type ProviderLaunchSource = "default" | "append" | "override";

export interface ResolvedProviderLaunch {
  command: string;
  args: string[];
  source: ProviderLaunchSource;
}

export interface ProviderLaunchAvailability {
  available: boolean;
  resolvedPath: string | null;
}

export interface ProviderLaunchDefault {
  command: string;
  resolvePath?: () => Promise<string | null>;
}

function normalizeLaunchDefault(
  defaultBinary: string | ProviderLaunchDefault,
): ProviderLaunchDefault {
  if (typeof defaultBinary === "string") {
    return { command: defaultBinary };
  }
  return defaultBinary;
}

async function resolveLaunchPath(command: string): Promise<string | null> {
  const found = await findExecutable(command);
  if (found) {
    return found;
  }
  if (isAbsolute(command)) {
    return executableExists(command);
  }
  return null;
}

async function resolveDefaultLaunchPath(
  defaultBinary: ProviderLaunchDefault,
): Promise<string | null> {
  return defaultBinary.resolvePath
    ? await defaultBinary.resolvePath()
    : await resolveLaunchPath(defaultBinary.command);
}

export interface ResolveProviderLaunchOptions {
  commandConfig?: ProviderCommand;
  defaultBinary?: string | ProviderLaunchDefault;
}

export async function resolveProviderLaunch({
  commandConfig,
  defaultBinary,
}: ResolveProviderLaunchOptions): Promise<ResolvedProviderLaunch> {
  if (commandConfig?.mode === "replace") {
    const command = commandConfig.argv[0];
    return {
      command,
      args: commandConfig.argv.slice(1),
      source: "override",
    };
  }

  if (defaultBinary === undefined) {
    throw new Error("defaultBinary is required when provider command is not replaced");
  }
  const normalizedDefault = normalizeLaunchDefault(defaultBinary);
  const args = commandConfig?.mode === "append" ? [...(commandConfig.args ?? [])] : [];
  return {
    command: normalizedDefault.command,
    args,
    source: commandConfig?.mode === "append" ? "append" : "default",
  };
}

export async function checkProviderLaunchAvailable(
  launch: ResolvedProviderLaunch,
  defaultBinary?: ProviderLaunchDefault,
): Promise<ProviderLaunchAvailability> {
  const resolvedPath =
    defaultBinary && launch.source !== "override"
      ? await resolveDefaultLaunchPath(defaultBinary)
      : await resolveLaunchPath(launch.command);
  return {
    available: resolvedPath !== null,
    resolvedPath,
  };
}

export async function resolveProviderCommandPrefix(
  commandConfig: ProviderCommand | undefined,
  resolveDefaultCommand: () => string | Promise<string>,
): Promise<ProviderCommandPrefix> {
  if (commandConfig?.mode === "replace") {
    const launch = await resolveProviderLaunch({
      commandConfig,
    });
    return {
      command: launch.command,
      args: launch.args,
    };
  }

  const defaultCommand = await resolveDefaultCommand();
  const launch = await resolveProviderLaunch({
    commandConfig,
    defaultBinary: {
      command: defaultCommand,
      resolvePath: async () => defaultCommand,
    },
  });
  return {
    command: launch.command,
    args: launch.args,
  };
}

let cachedShellEnv: Record<string, string> | null = null;

export function resolveShellEnv(): Record<string, string> {
  if (cachedShellEnv) {
    return cachedShellEnv;
  }
  cachedShellEnv = { ...process.env } as Record<string, string>;
  return cachedShellEnv;
}

export function migrateProviderSettings(
  raw: Record<string, unknown>,
  builtinProviderIds: string[],
): Record<string, ProviderOverride> {
  const migrated: Record<string, ProviderOverride> = {};
  const builtinProviderIdSet = new Set(builtinProviderIds);

  for (const [providerId, value] of Object.entries(raw)) {
    const parsedNew = ProviderOverrideSchema.safeParse(value);
    if (parsedNew.success) {
      migrated[providerId] = parsedNew.data;
      continue;
    }

    const parsedOld = ProviderRuntimeSettingsSchema.safeParse(value);
    if (!parsedOld.success) {
      continue;
    }

    const nextEntry: ProviderOverride = {};
    const command = parsedOld.data.command;
    if (command?.mode === "append") {
      continue;
    }
    if (command?.mode === "replace") {
      nextEntry.command = command.argv;
    }
    if (parsedOld.data.env) {
      nextEntry.env = parsedOld.data.env;
    }
    if (!builtinProviderIdSet.has(providerId) && nextEntry.extends === undefined) {
      delete nextEntry.extends;
    }
    migrated[providerId] = nextEntry;
  }

  return migrated;
}

// Env vars that indicate a running Claude Code session. If the daemon itself is
// launched from inside Claude Code (e.g. by a Paseo agent), these leak into
// child processes and cause "cannot be launched inside another session" errors.
const PARENT_SESSION_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
];

export interface ProviderEnvOptions {
  baseEnv?: ProcessEnvRecord;
  runtimeSettings?: ProviderRuntimeSettings;
  overlays?: Array<ProcessEnvRecord | undefined>;
}

export interface ProviderEnvSpec {
  baseEnv?: ProcessEnvRecord;
  envOverlay: ProcessEnvRecord;
}

function collectProviderEnvOverlays(
  runtimeSettings: ProviderRuntimeSettings | undefined,
  overlays: Array<ProcessEnvRecord | undefined>,
): ProcessEnvRecord[] {
  return [runtimeSettings?.env, ...overlays].filter(
    (overlay): overlay is ProcessEnvRecord => !!overlay,
  );
}

export function createProviderEnvSpec(options: ProviderEnvOptions = {}): ProviderEnvSpec {
  const overlays = collectProviderEnvOverlays(options.runtimeSettings, options.overlays ?? []);
  const envOverlay: ProcessEnvRecord = Object.assign({}, ...overlays);
  for (const key of PARENT_SESSION_ENV_VARS) {
    envOverlay[key] = undefined;
  }
  return {
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    envOverlay,
  };
}

export function createProviderEnv(options: ProviderEnvOptions = {}): NodeJS.ProcessEnv {
  const spec = createProviderEnvSpec(options);
  return createExternalProcessEnv(spec.baseEnv ?? process.env, spec.envOverlay);
}

export async function isProviderCommandAvailable(
  commandConfig: ProviderCommand | undefined,
  resolveDefaultCommand: () => string | Promise<string>,
): Promise<boolean> {
  try {
    if (commandConfig?.mode === "replace") {
      const launch = await resolveProviderLaunch({
        commandConfig,
      });
      const availability = await checkProviderLaunchAvailable(launch);
      return availability.available;
    }

    const defaultCommand = await resolveDefaultCommand();
    const defaultBinary = {
      command: defaultCommand,
      resolvePath: async () => defaultCommand,
    };
    const launch = await resolveProviderLaunch({ commandConfig, defaultBinary });
    const availability = await checkProviderLaunchAvailable(launch, defaultBinary);
    return availability.available;
  } catch {
    return false;
  }
}
