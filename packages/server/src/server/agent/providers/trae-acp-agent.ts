import type { Logger } from "pino";

import type { ACPActiveTurnSteeringAdapter } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface TraeACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
}

const TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const traeActiveTurnSteeringAdapter: ACPActiveTurnSteeringAdapter = {
  isSupported(initialize) {
    // TraeX advertises this extension on initialize itself, not agentCapabilities.
    const meta = initialize._meta;
    if (!isRecord(meta) || !isRecord(meta.steering)) {
      return false;
    }
    return meta.steering.supported === true;
  },
  async steer({ connection, sessionId, prompt }) {
    const response = await connection.extMethod("_session/steering", { sessionId, prompt });
    // Any other receipt leaves delivery ambiguous. Surface the error without retry/fallback.
    if (!isRecord(response) || response.outcome !== "injected") {
      throw new Error("Trae active-turn steering did not confirm injection");
    }
  },
};

export class TraeACPAgentClient extends GenericACPAgentClient {
  constructor(options: TraeACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      activeTurnSteeringAdapter: traeActiveTurnSteeringAdapter,
      // traecli publishes slash commands and skills asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
  }
}
