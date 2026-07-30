import { isWeb } from "@/constants/platform";
import { useSessionStore } from "@/stores/session-store";

/**
 * Whether the Live Voice surface should exist for this agent at all.
 *
 * Three independent facts have to line up:
 *   - the client can run the WebRTC transport (web/Electron only in phase 1),
 *   - `server_info.features.liveVoice` — the daemon speaks the `voice.live.*` RPCs,
 *   - the agent's own `supportsLiveVoice` capability — this codex process was
 *     launched with realtime support.
 *
 * `capabilities` has an open boolean index, so `supportsLiveVoice` is read
 * tolerantly: absent means false, never an error.
 */
export function useIsLiveVoiceAvailable(serverId: string, agentId: string): boolean {
  // COMPAT(liveVoice): added in v0.2.5, drop the gate when floor >= v0.2.5.
  const hostSupportsLiveVoice = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.liveVoice === true,
  );
  const agentSupportsLiveVoice = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents?.get(agentId)?.capabilities?.supportsLiveVoice === true,
  );
  return isWeb && hostSupportsLiveVoice && agentSupportsLiveVoice;
}
