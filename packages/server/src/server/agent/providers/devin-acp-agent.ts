import type { Logger } from "pino";

import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface DevinACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const DEVIN_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

export class DevinACPAgentClient extends GenericACPAgentClient {
  constructor(options: DevinACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // Devin CLI advertises slash commands asynchronously via the standard ACP
      // `available_commands_update` session update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: DEVIN_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
  }
}
