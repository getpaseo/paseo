import { homedir } from "node:os";
import type { Logger } from "pino";

import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { ACPAgentClient } from "./acp-agent.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  buildBinaryDiagnosticRows,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const ANTIGRAVITY_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

// Modes are discovered dynamically via ACP at runtime.
const ANTIGRAVITY_DEFAULT_MODES: AgentMode[] = [];

interface AntigravityACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

export class AntigravityACPAgentClient extends ACPAgentClient {
  constructor(options: AntigravityACPAgentClientOptions) {
    super({
      provider: "antigravity",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["agy", "--acp"],
      defaultModes: ANTIGRAVITY_DEFAULT_MODES,
      capabilities: ANTIGRAVITY_CAPABILITIES,
    });
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: "agy",
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
      }

      return {
        diagnostic: formatProviderDiagnostic("Antigravity", [
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Antigravity", error),
      };
    }
  }
}
