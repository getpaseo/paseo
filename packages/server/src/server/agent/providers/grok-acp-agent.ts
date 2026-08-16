import type { Logger } from "pino";

import { GenericACPAgentClient } from "./generic-acp-agent.js";
import {
  isGrokHiddenFromScrollbackUserChunk,
  mapGrokExtensionNotificationToTimelineItems,
} from "./grok-background-tasks.js";

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

/**
 * Grok is installed from the ACP catalog as `grok agent stdio`.
 * Honor `_meta.hideFromScrollback` and map `_x.ai/session/update` task events
 * to synthetic tool_call items. Permission UX stays on generic ACP Auto Accept.
 */
export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId ?? "grok",
      label: options.label ?? "Grok",
      providerParams: options.providerParams,
      shouldSuppressUserMessageChunk: isGrokHiddenFromScrollbackUserChunk,
      extensionNotificationHandler: mapGrokExtensionNotificationToTimelineItems,
    });
  }
}
