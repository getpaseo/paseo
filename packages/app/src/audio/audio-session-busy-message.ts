import { i18n } from "@/i18n/i18next";
import type { AudioSessionOwner } from "@/audio/audio-session-lease";

const BUSY_MESSAGE_KEYS: Record<AudioSessionOwner, string> = {
  voiceMode: "audioSession.busy.voiceMode",
  dictation: "audioSession.busy.dictation",
  liveVoice: "audioSession.busy.liveVoice",
};

/**
 * Message for a refused microphone acquisition. Used by the non-React voice
 * runtime and the dictation hook, which both surface it through their existing
 * error paths (a thrown `Error` and `setError` respectively).
 */
export function resolveAudioSessionBusyMessage(owner: AudioSessionOwner | null): string {
  return i18n.t(owner ? BUSY_MESSAGE_KEYS[owner] : "audioSession.busy.unknown");
}
