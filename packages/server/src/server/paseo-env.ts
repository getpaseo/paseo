import { realpathSync } from "node:fs";
import path from "node:path";

const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
] as const;

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

let resolvedProcessExecPath: string | undefined;

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  const sanitized = Object.assign({}, baseEnv, ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

function normalizeExecutablePath(executablePath: string): string {
  return process.platform === "win32" ? executablePath.toLowerCase() : executablePath;
}

function resolveExecutablePath(executablePath: string): string | undefined {
  try {
    return realpathSync.native(executablePath);
  } catch {
    return undefined;
  }
}

function isProcessExecPathCommand(command: string): boolean {
  if (command === process.execPath) {
    return true;
  }
  if (!path.isAbsolute(command)) {
    return false;
  }

  resolvedProcessExecPath ??= resolveExecutablePath(process.execPath);
  const resolvedCommand = resolveExecutablePath(command);
  if (!resolvedCommand || !resolvedProcessExecPath) {
    return false;
  }

  return (
    normalizeExecutablePath(resolvedCommand) === normalizeExecutablePath(resolvedProcessExecPath)
  );
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  const env = buildExternalProcessEnv(baseEnv, overlays);
  if (isProcessExecPathCommand(command)) {
    env[ELECTRON_RUN_AS_NODE] = "1";
  }
  return env;
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}
