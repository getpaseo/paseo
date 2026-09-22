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

export function getHermesMultiplexManager(
  logger: Logger,
  command: [string, ...string[]],
  env?: Record<string, string>,
): ACPMultiplexConnectionManager {
  const profileKey = env?.HERMES_PROFILE || env?.HERMES_HOME || "default";
  const managerKey = `${command.join(" ")}::${profileKey}`;
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
      transportAcquirer: (opts) => manager.acquire(opts),
    });
    this.multiplexManager = manager;
    this.providerParams = providerParams;
  }
}
