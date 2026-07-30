import type { LiveVoiceErrorInfo } from "@/live-voice/live-voice-runtime";

/**
 * Error codes stay open strings on the wire, so this map is a best-effort
 * translation table rather than an exhaustive switch: an unknown code from a newer
 * daemon falls back to the server-supplied message, and only then to a generic
 * failure string.
 */
const ERROR_MESSAGE_KEYS: Record<string, string> = {
  // Daemon rejections (voice.live.start.response.errorCode).
  busy: "liveVoice.errors.busy",
  unsupported: "liveVoice.errors.unsupported",
  start_failed: "liveVoice.errors.startFailed",
  // Local runtime refusals.
  mic_busy: "liveVoice.errors.micBusy",
  not_connected: "liveVoice.errors.notConnected",
  already_active: "liveVoice.errors.alreadyActive",
  stopping: "liveVoice.errors.stopping",
  // Local transport failures (LiveVoiceSessionError).
  mic_denied: "liveVoice.errors.micDenied",
  mic_unavailable: "liveVoice.errors.micUnavailable",
  background_unavailable: "liveVoice.errors.backgroundUnavailable",
  ice_timeout: "liveVoice.errors.iceTimeout",
  webrtc_failed: "liveVoice.errors.connectionLost",
};

export function resolveLiveVoiceErrorMessage(
  info: LiveVoiceErrorInfo,
  translate: (key: string) => string,
): string {
  const key = ERROR_MESSAGE_KEYS[info.code];
  if (key) {
    return translate(key);
  }
  return info.message ?? translate("liveVoice.errors.startFailed");
}
