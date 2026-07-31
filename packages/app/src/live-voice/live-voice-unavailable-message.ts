import type { LiveVoiceUnavailableReason } from "@/live-voice/live-voice-availability-policy";

const UNAVAILABLE_MESSAGE_KEYS: Record<LiveVoiceUnavailableReason, string> = {
  platform_unsupported: "liveVoice.unavailable.platform",
  no_hosts: "liveVoice.unavailable.noHosts",
  hosts_connecting: "liveVoice.unavailable.connecting",
  hosts_offline: "liveVoice.unavailable.offline",
  host_upgrade_required: "liveVoice.unavailable.upgrade",
};

/** The one short human sentence for why live voice cannot start right now. */
export function resolveLiveVoiceUnavailableMessage(
  reason: LiveVoiceUnavailableReason,
  translate: (key: string) => string,
): string {
  return translate(UNAVAILABLE_MESSAGE_KEYS[reason]);
}
