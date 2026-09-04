import type { Logger } from "pino";

import { GenericACPAgentClient } from "./generic-acp-agent.js";

export class HermesACPAgentClient extends GenericACPAgentClient {
  constructor(options: {
    logger: Logger;
    command: [string, ...string[]];
    env?: Record<string, string>;
    providerId?: string;
    label?: string;
    providerParams?: Record<string, unknown>;
  }) {
    super({
      ...options,
      providerParams: {
        ...options.providerParams,
        activeTurnSteering: options.providerParams?.activeTurnSteering ?? "concurrent_prompt",
      },
    });
  }
}
