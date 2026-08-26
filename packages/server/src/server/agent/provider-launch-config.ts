import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  executableExists,
  findExecutable,
} from "../../executable-resolution/executable-resolution.js";
import { createExternalProcessEnv, type ProcessEnvRecord } from "../paseo-env.js";
export {
  AgentProviderRuntimeSettingsMapSchema,
  ProviderCommandSchema,
  ProviderOverrideSchema,
  ProviderOverridesSchema,
  ProviderProfileModelSchema,
  ProviderRuntimeSettingsSchema,
  type AgentProviderRuntimeSettingsMap,
  type ProviderCommand,
  type ProviderOverride,
  type ProviderOverrides,
  type ProviderProfileModel,
  type ProviderRuntimeSettings,
} from "@getpaseo/protocol/provider-config";
import {
  ProviderOverrideSchema,
  ProviderOverridesSchema,
  ProviderRuntimeSettingsSchema,
  type ProviderCommand,
  type ProviderOverride,
  type ProviderOverrides,
  type ProviderRuntimeSettings,
} from "@getpaseo/protocol/provider-config";

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
const MAX_PROVIDER_SECRET_BYTES = 64 * 1024;

function readProviderSecret(name: string, file: string): string {
  if (!isAbsolute(file) || resolve(file) !== file) {
    throw new Error(`envFromFiles.${name} must use an absolute normalized path`);
  }
  if (typeof process.getuid !== "function") {
    throw new Error("Provider envFromFiles requires a POSIX daemon");
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(file);
  } catch (error) {
    throw new Error(`Unable to resolve provider secret for ${name}`, { cause: error });
  }
  if (canonicalPath !== file) {
    throw new Error(`Provider secret for ${name} must be canonical and not use symlinks`);
  }

  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`Unable to open provider secret for ${name}`, { cause: error });
  }

  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error(`Provider secret for ${name} is not a regular file`);
    if (info.uid !== process.getuid()) {
      throw new Error(`Provider secret for ${name} must be owned by the daemon user`);
    }
    if ((info.mode & 0o7777) !== 0o600) {
      throw new Error(`Provider secret for ${name} must have mode 0600`);
    }
    const pathInfo = statSync(file);
    if (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) {
      throw new Error(`Provider secret for ${name} changed while it was opened`);
    }
    if (info.size > MAX_PROVIDER_SECRET_BYTES) {
      throw new Error(`Provider secret for ${name} exceeds 64 KiB`);
    }

    const content = Buffer.allocUnsafe(MAX_PROVIDER_SECRET_BYTES + 1);
    let length = 0;
    while (length < content.length) {
      const bytesRead = readSync(descriptor, content, length, content.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_PROVIDER_SECRET_BYTES) {
      throw new Error(`Provider secret for ${name} exceeds 64 KiB`);
    }

    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, length));
    } catch (error) {
      throw new Error(`Provider secret for ${name} is not valid UTF-8`, { cause: error });
    }
    if (value.includes("\0")) throw new Error(`Provider secret for ${name} contains a NUL byte`);
    if (value.endsWith("\r\n")) return value.slice(0, -2);
    if (value.endsWith("\n")) return value.slice(0, -1);
    return value;
  } finally {
    closeSync(descriptor);
  }
}

export function resolveProviderEnvironment(
  runtimeSettings: ProviderRuntimeSettings | undefined,
): Record<string, string> | undefined {
  const files = runtimeSettings?.envFromFiles;
  if (!runtimeSettings?.env && !files) return undefined;
  const environment = { ...runtimeSettings?.env };
  for (const [name, file] of Object.entries(files ?? {})) {
    environment[name] = readProviderSecret(name, file);
  }
  return environment;
}

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
): ProviderOverrides {
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

  return ProviderOverridesSchema.parse(migrated);
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
  return [resolveProviderEnvironment(runtimeSettings), ...overlays].filter(
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
