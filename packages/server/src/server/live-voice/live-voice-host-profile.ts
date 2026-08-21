import type { AgentProvider, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { LiveVoiceContextLimits } from "./live-voice-context.js";

/**
 * Everything provider-specific about hosting a Live Voice call, supplied by a
 * provider adapter (see `agent/providers/live-voice-host-profiles.ts`). This
 * module must stay free of provider names: the profile is how a provider's
 * defaults reach the coordinator without the coordinator knowing whose they are.
 */
export interface LiveVoiceHostProfile {
  /** Agent provider that spawns the hidden host session. */
  provider: AgentProvider;
  /**
   * Default model for the host thread. A dispatcher, not a coder — it routes
   * work through Paseo's tools while the user waits — so adapters should pick a
   * fast, cheap model. A client's `backendModel` override replaces it.
   */
  model: string;
  thinkingOptionId: string;
  /** Provider-native restrictions for the hidden host session. */
  providerOptions?: AgentSessionConfig["providerOptions"];
  /** How the provider counts snapshot context, so budgeting matches its limits. */
  contextLimits: LiveVoiceContextLimits;
}
