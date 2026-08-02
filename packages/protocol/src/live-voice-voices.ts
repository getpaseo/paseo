/**
 * Used only when the host cannot read its catalog from Codex app-server.
 * Keep this aligned with the oldest Codex version that can advertise Live Voice.
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
