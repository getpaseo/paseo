import type { Logger } from "pino";
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";

import { GenericACPAgentClient } from "./generic-acp-agent.js";
import type { SessionStateResponse } from "./acp-agent.js";
import { withTimeout } from "../../../utils/promise-timeout.js";

interface GajaeCodeACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

export interface GajaeCodeProbeConnection {
  unstable_closeSession(params: { sessionId: string }): Promise<unknown>;
  extMethod(method: string, params: { sessionId: string }): Promise<unknown>;
}

const GAJAE_CODE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const GAJAE_CODE_CLOSE_SESSION_TIMEOUT_MS = 1_000;
const GAJAE_CODE_PLAN_MODE_ID = "plan";
const GAJAE_CODE_CONFIG_CATEGORIES: Record<string, string> = {
  mode: "mode",
  model: "model",
  thinking: "thought_level",
};
const GAJAE_CODE_CLIENT_CAPABILITY_META = {
  gjc: {
    // GJC gives client metadata precedence over its process environment. Keep
    // approvals on Paseo's permission surface, including the auto-accept toggle.
    permissionHandling: "prompt",
  },
};

export function transformGajaeCodeConfigOptions(
  configOptions: SessionConfigOption[],
): SessionConfigOption[] {
  return configOptions.map((option) => {
    const category = GAJAE_CODE_CONFIG_CATEGORIES[option.id];
    const needsCategory = category !== undefined && option.category === undefined;
    let normalized: SessionConfigOption = option;
    if (needsCategory) {
      normalized = { ...option, category };
    }
    if (normalized.type !== "select") {
      return normalized;
    }
    if (normalized.id !== "mode") {
      return normalized;
    }
    const flatOptions = normalized.options.filter(isFlatConfigChoice);
    if (flatOptions.length !== normalized.options.length) {
      return normalized;
    }
    if (normalized.currentValue === GAJAE_CODE_PLAN_MODE_ID) {
      return normalized;
    }
    return {
      ...normalized,
      options: flatOptions.filter((choice) => choice.value !== GAJAE_CODE_PLAN_MODE_ID),
    };
  });
}

function isFlatConfigChoice(
  choice: SessionConfigSelectGroup | SessionConfigSelectOption,
): choice is SessionConfigSelectOption {
  return "value" in choice;
}

export function transformGajaeCodeSessionResponse(
  response: SessionStateResponse,
): SessionStateResponse {
  // GJC's SDK-backed ACP host cannot install the interactive plan-mode
  // lifecycle, so selecting its advertised plan mode fails at runtime.
  const transformed: SessionStateResponse = { ...response };
  if (response.modes) {
    const availableModes =
      response.modes.currentModeId === GAJAE_CODE_PLAN_MODE_ID
        ? response.modes.availableModes
        : response.modes.availableModes?.filter((mode) => mode.id !== GAJAE_CODE_PLAN_MODE_ID);
    transformed.modes = { ...response.modes, availableModes };
  }
  if (response.configOptions) {
    transformed.configOptions = transformGajaeCodeConfigOptions(response.configOptions);
  }
  return transformed;
}

export async function cleanupGajaeCodeProbeSession(
  connection: GajaeCodeProbeConnection,
  sessionId: string,
): Promise<void> {
  try {
    await withTimeout(
      connection.unstable_closeSession({ sessionId }),
      GAJAE_CODE_CLOSE_SESSION_TIMEOUT_MS,
      `Gajae Code probe session close timed out after ${GAJAE_CODE_CLOSE_SESSION_TIMEOUT_MS}ms`,
    );
  } finally {
    await connection.extMethod("session/delete", { sessionId });
  }
}

export class GajaeCodeACPAgentClient extends GenericACPAgentClient {
  constructor(options: GajaeCodeACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // GJC publishes skills and slash commands after session/new completes.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: GAJAE_CODE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      sessionResponseTransformer: transformGajaeCodeSessionResponse,
      configOptionsTransformer: transformGajaeCodeConfigOptions,
      probeSessionCleanup: cleanupGajaeCodeProbeSession,
      clientCapabilityMeta: GAJAE_CODE_CLIENT_CAPABILITY_META,
    });
  }
}
