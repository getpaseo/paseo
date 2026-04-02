import type { Logger } from "pino";

import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { ACPAgentClient } from "./acp-agent.js";

const COPILOT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const COPILOT_MODES: AgentMode[] = [
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#agent",
    label: "Agent",
    description: "Default agent mode for conversational interactions",
  },
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#plan",
    label: "Plan",
    description: "Plan mode for creating and executing multi-step plans",
  },
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#autopilot",
    label: "Autopilot",
    description: "Autonomous mode that runs until task completion without user interaction",
  },
];

type CopilotACPAgentClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

export class CopilotACPAgentClient extends ACPAgentClient {
  constructor(options: CopilotACPAgentClientOptions) {
    super({
      provider: "copilot",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["copilot", "--acp"],
      defaultModes: COPILOT_MODES,
      capabilities: COPILOT_CAPABILITIES,
    });
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }
}
