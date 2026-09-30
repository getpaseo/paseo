import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OMP_MODES } from "@getpaseo/protocol/provider-manifest";
import { z } from "zod";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

const DEFAULT_OMP_MODE_ID = "full";
const DEFAULT_OMP_READY_TIMEOUT_MS = 20_000;
const DEFAULT_OMP_RPC_TIMEOUT_MS = 60_000;

export const MIN_SUPPORTED_OMP_VERSION = "16.3.9";
export { OMP_MODES };

export const OmpProviderOptionsSchema = z
  .object({
    sessionDir: z.string().min(1).optional(),
    rpcTimeoutMs: z.number().int().positive().optional(),
    smolModel: z.string().min(1).optional(),
    slowModel: z.string().min(1).optional(),
    planModel: z.string().min(1).optional(),
  })
  .strict();

export interface OmpRuntimeOptions {
  sessionDir?: string;
  readyTimeoutMs: number;
  rpcTimeoutMs: number;
}

export interface OmpModelRoles {
  smolModel?: string;
  slowModel?: string;
  planModel?: string;
}

export function resolveOmpLaunchMode(
  modeId: string | undefined,
  modelRoles: OmpModelRoles = {},
): { modeId: string; extraArgs: string[] } {
  const modelRoleArgs = resolveOmpModelRoleArgs(modelRoles);
  switch (modeId ?? DEFAULT_OMP_MODE_ID) {
    case "full":
      return { modeId: "full", extraArgs: ["--approval-mode", "yolo", ...modelRoleArgs] };
    case "write":
      return {
        modeId: "write",
        extraArgs: ["--approval-mode", "write", ...modelRoleArgs],
      };
    case "ask":
      return {
        modeId: "ask",
        extraArgs: ["--approval-mode", "always-ask", ...modelRoleArgs],
      };
    default:
      throw new Error(`Unsupported OMP mode '${modeId}'`);
  }
}

function resolveOmpModelRoleArgs(modelRoles: OmpModelRoles): string[] {
  const args: string[] = [];
  if (modelRoles.smolModel) args.push("--smol", modelRoles.smolModel);
  if (modelRoles.slowModel) args.push("--slow", modelRoles.slowModel);
  if (modelRoles.planModel) args.push("--plan", modelRoles.planModel);
  return args;
}

export interface OmpDiagnosticPaths {
  profile: string;
  configRoot: string;
  agentDir: string;
  agentDb: string;
  xdgDataRoot: string;
  xdgStateRoot: string;
  xdgCacheRoot: string;
}

export function resolveOmpDiagnosticPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): OmpDiagnosticPaths {
  const normalizedProfile = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
  const profile =
    normalizedProfile && normalizedProfile !== "default" ? normalizedProfile : "default";
  const baseConfigRoot = join(home, env.PI_CONFIG_DIR || ".omp");
  const configRoot =
    profile === "default" ? baseConfigRoot : join(baseConfigRoot, "profiles", profile);
  const defaultAgentDir = join(configRoot, "agent");
  const agentDir =
    profile === "default" && env.PI_CODING_AGENT_DIR
      ? resolve(env.PI_CODING_AGENT_DIR)
      : defaultAgentDir;
  const xdgSupported = platform === "linux" || platform === "darwin";
  const resolveXdgRoot = (variable: "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME") => {
    const base = env[variable];
    if (!xdgSupported || agentDir !== defaultAgentDir || !base) return undefined;
    const appRoot = join(base, "omp");
    const candidate = profile === "default" ? appRoot : join(appRoot, "profiles", profile);
    return existsSync(candidate) ? candidate : undefined;
  };
  const xdgDataRoot = resolveXdgRoot("XDG_DATA_HOME") ?? configRoot;
  const xdgStateRoot = resolveXdgRoot("XDG_STATE_HOME") ?? configRoot;
  const xdgCacheRoot = resolveXdgRoot("XDG_CACHE_HOME") ?? configRoot;

  return {
    profile,
    configRoot,
    agentDir,
    agentDb: join(xdgDataRoot === configRoot ? agentDir : xdgDataRoot, "agent.db"),
    xdgDataRoot,
    xdgStateRoot,
    xdgCacheRoot,
  };
}

export function formatOmpVersionSupport(versionOutput: string): string {
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return `unknown (minimum ${MIN_SUPPORTED_OMP_VERSION})`;
  const installed = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = MIN_SUPPORTED_OMP_VERSION.split(".").map(Number);
  const supported =
    installed[0]! > minimum[0]! ||
    (installed[0] === minimum[0] &&
      (installed[1]! > minimum[1]! ||
        (installed[1] === minimum[1]! && installed[2]! >= minimum[2]!)));
  return `${match[1]}.${match[2]}.${match[3]} (${supported ? "supported" : "unsupported"}; minimum ${MIN_SUPPORTED_OMP_VERSION})`;
}

export function resolveOmpProviderOptions(providerOptions: unknown): {
  runtimeOptions: OmpRuntimeOptions;
  modelRoles: OmpModelRoles;
} {
  const options = OmpProviderOptionsSchema.parse(providerOptions ?? {});
  const configuredRpcTimeoutMs = options.rpcTimeoutMs;
  return {
    runtimeOptions: {
      sessionDir: options.sessionDir,
      readyTimeoutMs: configuredRpcTimeoutMs ?? DEFAULT_OMP_READY_TIMEOUT_MS,
      rpcTimeoutMs: configuredRpcTimeoutMs ?? DEFAULT_OMP_RPC_TIMEOUT_MS,
    },
    modelRoles: {
      ...(options.smolModel ? { smolModel: options.smolModel } : {}),
      ...(options.slowModel ? { slowModel: options.slowModel } : {}),
      ...(options.planModel ? { planModel: options.planModel } : {}),
    },
  };
}

export function mergeOmpRuntimeSettings(
  base: ProviderRuntimeSettings | undefined,
  override: ProviderRuntimeSettings | undefined,
): ProviderRuntimeSettings | undefined {
  if (!base && !override) return undefined;
  return {
    command: override?.command ?? base?.command,
    env: base?.env || override?.env ? { ...base?.env, ...override?.env } : undefined,
    disallowedTools:
      base?.disallowedTools || override?.disallowedTools
        ? [...(base?.disallowedTools ?? []), ...(override?.disallowedTools ?? [])]
        : undefined,
  };
}
