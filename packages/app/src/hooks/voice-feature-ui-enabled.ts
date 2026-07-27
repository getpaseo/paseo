import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { DaemonServerInfo } from "@/stores/session-store";
import { isVoiceFeatureEnabled, type VoiceReadinessMode } from "@/utils/server-info-capabilities";

/**
 * Whether the composer should show a voice feature control.
 * Voice/dictation are opt-in: hide until daemon config explicitly enables them.
 * Once enabled, config is authoritative immediately (capabilities lag while speech
 * runtime reconfigures).
 */
export function resolveVoiceFeatureUiEnabled(input: {
  config: MutableDaemonConfig | null;
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): boolean {
  if (!input.config) {
    return false;
  }

  const fromConfig =
    input.mode === "dictation" ? input.config.dictation?.enabled : input.config.voiceMode?.enabled;
  if (fromConfig !== true) {
    return false;
  }

  const capabilityEnabled = isVoiceFeatureEnabled({
    serverInfo: input.serverInfo,
    mode: input.mode,
  });
  if (capabilityEnabled === false) {
    return false;
  }

  return true;
}
