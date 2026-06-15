import type { Logger } from "pino";
import { homedir } from "node:os";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import {
  ACPAgentClient,
  type ACPBeforeModeWriteResult,
  type ACPProviderModeWriteResult,
  type ACPProviderModeWriterContext,
  type SessionStateResponse,
} from "./acp-agent.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  buildBinaryDiagnosticRows,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const COPILOT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

const COPILOT_AGENT_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#agent";
const COPILOT_PLAN_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#plan";
const COPILOT_AUTOPILOT_MODE_ID =
  "https://agentclientprotocol.com/protocol/session-modes#autopilot";
export const COPILOT_ALLOW_ALL_MODE_ID = "allow-all";
const COPILOT_ALLOW_ALL_CONFIG_ID = "allow_all";
const COPILOT_ALLOW_ALL_ON = "on";
const COPILOT_ALLOW_ALL_OFF = "off";
type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;

export const COPILOT_MODES: AgentMode[] = [
  {
    id: COPILOT_AGENT_MODE_ID,
    label: "Agent",
    description: "Default agent mode for conversational interactions",
  },
  {
    id: COPILOT_PLAN_MODE_ID,
    label: "Plan",
    description: "Plan mode for creating and executing multi-step plans",
  },
  {
    id: COPILOT_ALLOW_ALL_MODE_ID,
    label: "Allow All",
    description: "Automatically approves all Copilot tool, path, and URL requests.",
  },
];

interface CopilotACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

export class CopilotACPAgentClient extends ACPAgentClient {
  constructor(options: CopilotACPAgentClientOptions) {
    super({
      provider: "copilot",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["copilot", "--acp"],
      defaultModes: COPILOT_MODES,
      sessionResponseTransformer: transformCopilotSessionResponse,
      configOptionsTransformer: transformCopilotConfigOptions,
      modeIdTransformer: transformCopilotModeId,
      providerModeWriter: writeCopilotProviderMode,
      beforeModeWriter: beforeCopilotModeWriter,
      capabilities: COPILOT_CAPABILITIES,
    });
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: "copilot",
      });
      const availability = await checkProviderLaunchAvailable(launch);
      const available = availability.available;
      let modelsValue = "Not checked";
      let status = formatDiagnosticStatus(available);

      if (available) {
        try {
          const models = await this.listModels({ cwd: homedir(), force: false });
          modelsValue = String(models.length);
        } catch (error) {
          modelsValue = `Error - ${toDiagnosticErrorMessage(error)}`;
          status = formatDiagnosticStatus(available, {
            source: "model fetch",
            cause: error,
          });
        }

        if (!modelsValue.startsWith("Error -")) {
          try {
            await this.listModes({ cwd: homedir(), force: false });
          } catch (error) {
            status = formatDiagnosticStatus(available, {
              source: "mode fetch",
              cause: error,
            });
          }
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("Copilot", [
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Copilot", error),
      };
    }
  }
}

export function transformCopilotSessionResponse(
  response: SessionStateResponse,
): SessionStateResponse {
  if (!response.modes) {
    return response;
  }
  const allowAllEnabled = isCopilotAllowAllEnabled(response.configOptions ?? []);
  return {
    ...response,
    modes: {
      ...response.modes,
      availableModes: response.modes.availableModes
        ?.filter(
          (mode) => mode.id !== COPILOT_AUTOPILOT_MODE_ID && mode.id !== COPILOT_ALLOW_ALL_MODE_ID,
        )
        .concat({
          id: COPILOT_ALLOW_ALL_MODE_ID,
          name: "Allow All",
          description: "Automatically approves all Copilot tool, path, and URL requests.",
        }),
      currentModeId: allowAllEnabled
        ? COPILOT_ALLOW_ALL_MODE_ID
        : (transformCopilotModeId(response.modes.currentModeId ?? COPILOT_AGENT_MODE_ID) ??
          COPILOT_AGENT_MODE_ID),
    },
  };
}

export function transformCopilotConfigOptions(
  configOptions: SessionConfigOption[],
): SessionConfigOption[] {
  const allowAllEnabled = isCopilotAllowAllEnabled(configOptions);
  return configOptions.map((option) => {
    if (option.type !== "select" || option.category !== "mode") {
      return option;
    }
    // Trust Copilot's allow_all config value as the source of truth when it changes in-process.
    const options = flattenCopilotModeOptions(option.options)
      .filter(
        (choice) =>
          choice.value !== COPILOT_AUTOPILOT_MODE_ID && choice.value !== COPILOT_ALLOW_ALL_MODE_ID,
      )
      .concat({
        value: COPILOT_ALLOW_ALL_MODE_ID,
        name: "Allow All",
        description: "Automatically approves all Copilot tool, path, and URL requests.",
      });
    return {
      ...option,
      currentValue: allowAllEnabled
        ? COPILOT_ALLOW_ALL_MODE_ID
        : (transformCopilotModeId(option.currentValue) ?? COPILOT_AGENT_MODE_ID),
      options,
    };
  });
}

function flattenCopilotModeOptions(
  options: SelectConfigOption["options"],
): Array<{ value: string; name: string; description?: string | null }> {
  const flattened: Array<{ value: string; name: string; description?: string | null }> = [];
  for (const option of options) {
    if ("value" in option) {
      flattened.push(option);
      continue;
    }
    flattened.push(...option.options);
  }
  return flattened;
}

export function transformCopilotModeId(modeId: string): string | null {
  return modeId === COPILOT_AUTOPILOT_MODE_ID ? COPILOT_AGENT_MODE_ID : modeId;
}

export async function writeCopilotProviderMode(
  context: ACPProviderModeWriterContext,
): Promise<ACPProviderModeWriteResult> {
  // COMPAT(copilotAutopilotMode): added in v0.1.75, remove after 2026-11-12 once old clients no longer send Copilot's old ACP autopilot mode ID.
  const requestsAllowAll =
    context.requestedModeId === COPILOT_ALLOW_ALL_MODE_ID ||
    context.requestedModeId === COPILOT_AUTOPILOT_MODE_ID;
  if (!requestsAllowAll) {
    return { handled: false };
  }
  const response = await context.connection.setSessionConfigOption({
    sessionId: context.sessionId,
    configId: COPILOT_ALLOW_ALL_CONFIG_ID,
    value: COPILOT_ALLOW_ALL_ON,
  });
  return {
    handled: true,
    currentModeId: COPILOT_ALLOW_ALL_MODE_ID,
    configOptions: response.configOptions,
  };
}

export async function beforeCopilotModeWriter(
  context: ACPProviderModeWriterContext,
): Promise<ACPBeforeModeWriteResult> {
  if (
    context.currentModeId !== COPILOT_ALLOW_ALL_MODE_ID ||
    context.requestedModeId === COPILOT_ALLOW_ALL_MODE_ID
  ) {
    return {};
  }
  const response = await context.connection.setSessionConfigOption({
    sessionId: context.sessionId,
    configId: COPILOT_ALLOW_ALL_CONFIG_ID,
    value: COPILOT_ALLOW_ALL_OFF,
  });
  return { configOptions: response.configOptions };
}

function isCopilotAllowAllEnabled(configOptions: SessionConfigOption[]): boolean {
  return configOptions.some(
    (option) =>
      option.type === "select" &&
      option.id === COPILOT_ALLOW_ALL_CONFIG_ID &&
      option.currentValue === COPILOT_ALLOW_ALL_ON,
  );
}
