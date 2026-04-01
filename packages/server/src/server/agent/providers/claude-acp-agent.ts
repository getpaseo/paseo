import type { Logger } from "pino";

import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { ACPAgentClient } from "./acp-agent.js";

const CLAUDE_ACP_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const CLAUDE_ACP_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Always Ask",
    description: "Prompts for permission the first time a tool is used",
  },
  {
    id: "acceptEdits",
    label: "Accept File Edits",
    description: "Automatically approves edit-focused tools without prompting",
  },
  {
    id: "plan",
    label: "Plan Mode",
    description: "Analyze the codebase without executing tools or edits",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    description: "Skip all permission prompts (use with caution)",
  },
];

type ClaudeACPAgentClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

export class ClaudeACPAgentClient extends ACPAgentClient {
  constructor(options: ClaudeACPAgentClientOptions) {
    super({
      provider: "claude-acp",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
      defaultModes: CLAUDE_ACP_MODES,
      capabilities: CLAUDE_ACP_CAPABILITIES,
    });
  }

  override async isAvailable(): Promise<boolean> {
    if (!(await super.isAvailable())) {
      return false;
    }
    return Boolean(process.env["CLAUDE_CODE_OAUTH_TOKEN"] || process.env["ANTHROPIC_API_KEY"]);
  }
}
