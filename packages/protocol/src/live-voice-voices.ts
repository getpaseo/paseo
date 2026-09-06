/**
 * Used only when the host cannot read a live catalog from its realtime
 * provider. Keep this aligned with the oldest host-provider version that can
 * advertise Live Voice.
 */
export const FALLBACK_LIVE_VOICE_OPTIONS = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const;
