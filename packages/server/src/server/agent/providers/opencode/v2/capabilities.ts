import type { AgentCapabilityFlags } from "../../../agent-sdk-types.js";
export const V2_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindBoth: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
};
