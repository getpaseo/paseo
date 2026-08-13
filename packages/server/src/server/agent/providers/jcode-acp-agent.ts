import type { Logger } from "pino";

import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { ACPAgentClient } from "./acp-agent.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "./diagnostic-utils.js";

// Jcode is a harness, not a mode-based agent. Its ACP adapter reports no session
// modes, so Paseo must not try to set one (jcode does not implement session/set_mode).
const JCODE_MODES: AgentMode[] = [];

const JCODE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  // jcode's ACP adapter implements session/load (loadSession: true), so persisted
  // sessions resume by attaching to the existing jcode session id.
  supportsSessionPersistence: true,
  // jcode's ACP adapter does not implement session/list.
  supportsSessionListing: false,
  // jcode's ACP adapter reports no session modes and does not implement session/set_mode.
  supportsDynamicModes: false,
  // jcode's ACP adapter tolerates but ignores `mcpServers` (session-scoped MCP is
  // not implemented server-side yet), so Paseo must not inject its MCP server.
  supportsMcpServers: false,
  // jcode does not emit agent_thought_chunk updates.
  supportsReasoningStream: false,
  // jcode streams tool_call and tool_call_update events through session/update.
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

interface JcodeACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

export class JcodeACPAgentClient extends ACPAgentClient {
  constructor(options: JcodeACPAgentClientOptions) {
    super({
      provider: "jcode",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["jcode", "acp"],
      defaultModes: JCODE_MODES,
      capabilities: JCODE_CAPABILITIES,
    });
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: "jcode",
      });
      const availability = await checkProviderLaunchAvailable(launch);

      return {
        diagnostic: formatProviderDiagnostic("Jcode", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["jcode"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Jcode", error),
      };
    }
  }
}
