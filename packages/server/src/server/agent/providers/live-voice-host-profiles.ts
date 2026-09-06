import type { LiveVoiceHostProfile } from "../../live-voice/live-voice-host-profile.js";
import { CODEX_LIVE_VOICE_HOST_PROFILE } from "./codex-live-voice-host-profile.js";

/**
 * Provider adapters that can host Live Voice, in preference order — the same
 * one-file-per-provider pattern as the quota fetchers. The daemon wires the
 * first entry; the coordinator itself never names a provider.
 */
export const LIVE_VOICE_HOST_PROFILES: readonly LiveVoiceHostProfile[] = [
  CODEX_LIVE_VOICE_HOST_PROFILE,
];

export function resolveLiveVoiceHostProfile(): LiveVoiceHostProfile {
  const profile = LIVE_VOICE_HOST_PROFILES[0];
  if (!profile) {
    throw new Error("No Live Voice host profile is registered.");
  }
  return profile;
}
