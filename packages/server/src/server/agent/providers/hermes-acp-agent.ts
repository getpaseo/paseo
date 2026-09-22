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

function buildManagerKey(command: string[], env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) {
    return command.join(" ");
  }
  const envPairs = Object.entries(env)
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
        const effectiveEnv = opts.launchEnv ? { ...options.env, ...opts.launchEnv } : options.env;
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
