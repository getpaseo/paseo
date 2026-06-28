import type { Logger } from "pino";

import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface KiroACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

// Kiro CLI publishes its slash commands and skills asynchronously through the
// `_kiro.dev/commands/available` extension notification shortly after
// `session/new` resolves (handled in ACPAgentSession.extNotification). Wait for
// that first batch so listCommands() doesn't resolve to an empty list before
// Kiro has reported its commands.
const KIRO_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

export class KiroACPAgentClient extends GenericACPAgentClient {
  constructor(options: KiroACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: KIRO_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
  }
}
