import type { DaemonServerInfo } from "@/stores/session-store";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";

export type TerminalDictationAvailability =
  | { kind: "ready" }
  | { kind: "disconnected" }
  | { kind: "unavailable"; reason: "update-host" }
  | { kind: "unavailable"; reason: "disabled"; message: string | null };

/**
 * Whether a terminal can dictate on this host. Gates on the host's explicit
 * dictation capability only: a host too old to report it is told to update, so a
 * terminal never falls back to the composer's agent-directory heuristic.
 */
export function resolveTerminalDictationAvailability(input: {
  serverInfo: DaemonServerInfo | null | undefined;
  isConnected: boolean;
}): TerminalDictationAvailability {
  if (!input.isConnected) {
    return { kind: "disconnected" };
  }
  const dictation = getVoiceReadinessState({ serverInfo: input.serverInfo, mode: "dictation" });
  if (!dictation) {
    return { kind: "unavailable", reason: "update-host" };
  }
  if (!dictation.enabled) {
    const message = dictation.reason.trim();
    return {
      kind: "unavailable",
      reason: "disabled",
      message: message.length > 0 ? message : null,
    };
  }
  return { kind: "ready" };
}
