import type { Logger } from "pino";

import type { AgentMode } from "../agent-sdk-types.js";
import type {
  ACPConfigFeatureOption,
  ACPProviderModeWriterContext,
  ACPProviderModeWriteResult,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface CursorACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_CLIENT_CAPABILITY_META = {
  parameterizedModelPicker: true,
};

export const CURSOR_FAST_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "fast",
  configId: "fast",
  label: "Fast",
  description: "Cursor fast mode",
  tooltip: "Select Cursor fast mode",
  icon: "zap",
};

export const CURSOR_ALLOW_ALL_MODE_ID = "allow-all";

// Paseo-owned synthetic mode: cursor-agent has no native allow-all, and its own
// permission config (approvalMode, --force) still prompts over ACP for some
// tool kinds (web search, MCP). Selecting it makes the daemon auto-approve
// every permission request client-side; nothing is written to cursor-agent. It
// is appended to the modes cursor-agent reports (Agent/Plan/Ask on current
// builds; older builds report none and keep no mode picker at all).
export const CURSOR_ALLOW_ALL_MODE: AgentMode = {
  id: CURSOR_ALLOW_ALL_MODE_ID,
  label: "Allow All",
  description: "Automatically approves all Cursor permission requests (use with caution)",
  icon: "ShieldOff",
  colorTier: "dangerous",
  isUnattended: true,
};

// The synthetic mode resolves locally (there is nothing to write to
// cursor-agent); native mode ids fall through to the normal ACP path.
export async function writeCursorProviderMode(
  context: ACPProviderModeWriterContext,
): Promise<ACPProviderModeWriteResult> {
  if (context.requestedModeId !== CURSOR_ALLOW_ALL_MODE_ID) {
    return { handled: false };
  }
  return { handled: true, currentModeId: context.requestedModeId };
}

export class CursorACPAgentClient extends GenericACPAgentClient {
  constructor(options: CursorACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // cursor-agent publishes slash commands asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      clientCapabilityMeta: CURSOR_CLIENT_CAPABILITY_META,
      configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION],
      syntheticModes: [CURSOR_ALLOW_ALL_MODE],
      autoApprovePermissionModeIds: [CURSOR_ALLOW_ALL_MODE_ID],
      providerModeWriter: writeCursorProviderMode,
    });
  }
}
