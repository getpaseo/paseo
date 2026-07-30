import { useSessionStore } from "@/stores/session-store";
import { isLiveVoiceSessionSupported } from "@/live-voice/live-voice-session";

/**
 * Whether the Live Voice surface should exist for this host at all.
 *
 * Two independent facts have to line up:
 *   - the current platform has a Live Voice WebRTC transport,
 *   - `server_info.features.liveVoice` — the daemon speaks the `voice.live.*`
 *     RPCs and can spawn its own voice host session.
 *
 * A call is daemon-global: whether any particular agent supports realtime voice
 * no longer matters, because the daemon provides its own host session.
 */
export function useIsLiveVoiceAvailable(serverId: string): boolean {
  // COMPAT(liveVoice): added in v0.2.5, drop the gate when floor >= v0.2.5.
  const hostSupportsLiveVoice = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.liveVoice === true,
  );
  return isLiveVoiceSessionSupported && hostSupportsLiveVoice;
}
