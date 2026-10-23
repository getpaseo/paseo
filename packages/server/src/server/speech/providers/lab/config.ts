export const LAB_DEFAULT_TTS_VOICE = "profile:winner-r6-s49-heart-alice-bella";
export const LAB_TTS_SAMPLE_RATE = 24000;
export const LAB_STT_SAMPLE_RATE = 16000;
export const LAB_CONNECT_TIMEOUT_MS = 1500;

export interface LabSpeechConfig {
  ttsUrl?: string;
  sttUrl?: string;
  ttsVoice: string;
  connectTimeoutMs: number;
}

/**
 * Reads the lab endpoints from the environment. Names only; values never live in git.
 *   PASEO_LAB_TTS_URL             ws(s) URL of the lab TTS server (unset: lab TTS off)
 *   PASEO_LAB_STT_URL             ws(s) URL of the lab STT server (unset: lab STT off)
 *   PASEO_LAB_TTS_VOICE           voice or profile id (default: the locked preset)
 *   PASEO_LAB_CONNECT_TIMEOUT_MS  connect timeout before falling back (default 1500)
 */
export function resolveLabSpeechConfig(env: NodeJS.ProcessEnv = process.env): LabSpeechConfig {
  const timeout = Number(env.PASEO_LAB_CONNECT_TIMEOUT_MS);
  return {
    ttsUrl: env.PASEO_LAB_TTS_URL?.trim() || undefined,
    sttUrl: env.PASEO_LAB_STT_URL?.trim() || undefined,
    ttsVoice: env.PASEO_LAB_TTS_VOICE?.trim() || LAB_DEFAULT_TTS_VOICE,
    connectTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : LAB_CONNECT_TIMEOUT_MS,
  };
}
