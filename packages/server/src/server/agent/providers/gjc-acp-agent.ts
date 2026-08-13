import type { Logger } from "pino";

import type { ACPClientCapabilityMeta } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface GjcACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const GJC_CLIENT_CAPABILITIES = {
  terminal: true,
};

const GJC_CLIENT_CAPABILITY_META = {
  gjc: {
    permissionHandling: "prompt",
  },
} satisfies ACPClientCapabilityMeta;

export class GjcACPAgentClient extends GenericACPAgentClient {
  constructor(options: GjcACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      clientCapabilities: GJC_CLIENT_CAPABILITIES,
      clientCapabilityMeta: GJC_CLIENT_CAPABILITY_META,
    });
  }
}
