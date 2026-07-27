import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { resolveVoiceFeatureUiEnabled } from "@/hooks/voice-feature-ui-enabled";
import { useSessionStore } from "@/stores/session-store";
import type { VoiceReadinessMode } from "@/utils/server-info-capabilities";

/**
 * Whether the composer should show a voice feature control.
 * Daemon config is authoritative as soon as the Settings toggle patches
 * (capabilities lag until speech runtime finishes reconfigure).
 */
export function useVoiceFeatureUiEnabled(serverId: string, mode: VoiceReadinessMode): boolean {
  const { config } = useDaemonConfig(serverId);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  return resolveVoiceFeatureUiEnabled({ config, serverInfo, mode });
}
