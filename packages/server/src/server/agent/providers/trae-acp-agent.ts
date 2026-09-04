import type { Logger } from "pino";
import type { ProviderTransport } from "../provider-launch-config.js";

import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface TraeACPAgentClientOptions {
  logger: Logger;
  command?: [string, ...string[]];
  transport?: ProviderTransport;
  authMethodId?: string;
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

export class TraeACPAgentClient extends GenericACPAgentClient {
  constructor(options: TraeACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      transport: options.transport,
      authMethodId: options.authMethodId,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // traecli publishes slash commands and skills asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
  }
}
