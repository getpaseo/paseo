import type { Logger } from "pino";

import { ACPMultiplexConnectionManager } from "./acp-multiplex-manager.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

export interface HermesACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
  multiplexManager?: ACPMultiplexConnectionManager;
}

const multiplexManagers = new Map<string, ACPMultiplexConnectionManager>();

const SESSION_EPHEMERAL_ENV_PREFIXES = ["PASEO_AGENT_", "PASEO_SESSION_"];
const SESSION_EPHEMERAL_ENV_KEYS = new Set([
  "PASEO_AGENT_ID",
  "PASEO_AGENT_CWD",
  "PASEO_SESSION_ID",
]);

export function filterTransportEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      SESSION_EPHEMERAL_ENV_KEYS.has(key) ||
      SESSION_EPHEMERAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      continue;
    }
    filtered[key] = value;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function buildManagerKey(command: string[], env?: Record<string, string>): string {
  const filtered = filterTransportEnv(env);
  if (!filtered || Object.keys(filtered).length === 0) {
    return command.join(" ");
  }
  const envPairs = Object.entries(filtered)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  return `${command.join(" ")}::${envPairs}`;
}

export function getHermesMultiplexManager(
  logger: Logger,
  command: [string, ...string[]],
  env?: Record<string, string>,
): ACPMultiplexConnectionManager {
  const managerKey = buildManagerKey(command, env);
  let manager = multiplexManagers.get(managerKey);
  if (!manager) {
    manager = new ACPMultiplexConnectionManager({
      logger,
      provider: "hermes",
      defaultCommand: command,
      runtimeSettings: { env },
      launchEnv: env,
    });
    multiplexManagers.set(managerKey, manager);
  }
  return manager;
}

export async function resetHermesMultiplexManagers(): Promise<void> {
  const managers = Array.from(multiplexManagers.values());
  multiplexManagers.clear();
  await Promise.all(managers.map((m) => m.shutdown()));
}

export class HermesACPAgentClient extends GenericACPAgentClient {
  readonly multiplexManager: ACPMultiplexConnectionManager;
  readonly providerParams: Record<string, unknown>;

  constructor(options: HermesACPAgentClientOptions) {
    const manager =
      options.multiplexManager ??
      getHermesMultiplexManager(options.logger, options.command, options.env);

    const rawParams =
      typeof options.providerParams === "object" && options.providerParams !== null
        ? (options.providerParams as Record<string, unknown>)
        : {};
    const providerParams = {
      activeTurnSteering: "concurrent_prompt",
      ...rawParams,
    };

    super({
      ...options,
      providerParams,
      transportAcquirer: (opts) => {
        const filteredLaunchEnv = filterTransportEnv(opts.launchEnv);
        const effectiveEnv = filteredLaunchEnv
          ? { ...options.env, ...filteredLaunchEnv }
          : options.env;
        const targetManager =
          options.multiplexManager ??
          getHermesMultiplexManager(options.logger, options.command, effectiveEnv);
        return targetManager.acquire(opts);
      },
    });
    this.multiplexManager = manager;
    this.providerParams = providerParams;
  }
}
