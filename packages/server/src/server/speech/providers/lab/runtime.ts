import type { Logger } from "pino";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { SpeechServices } from "../openai/runtime.js";
import { resolveLabSpeechConfig, type LabSpeechConfig } from "./config.js";
import { LabSTT } from "./stt.js";
import { LabTTS } from "./tts.js";

/**
 * Layers the lab providers over the services already initialised for voice. The previous
 * service (stock local or OpenAI) becomes the fallback, so a dead lab never silences the agent.
 * Does nothing unless PASEO_LAB_TTS_URL / PASEO_LAB_STT_URL are set.
 */
export function applyLabSpeechServices(params: {
  providers: RequestedSpeechProviders;
  existing: SpeechServices;
  logger: Logger;
  config?: LabSpeechConfig;
}): SpeechServices {
  const { providers, existing, logger } = params;
  const config = params.config ?? resolveLabSpeechConfig();
  let ttsService: TextToSpeechProvider | null = existing.ttsService;
  let sttService: SpeechToTextProvider | null = existing.sttService;

  if (config.ttsUrl && providers.voiceTts.enabled !== false) {
    ttsService = new LabTTS(
      {
        url: config.ttsUrl,
        voice: config.ttsVoice,
        connectTimeoutMs: config.connectTimeoutMs,
        idleTimeoutMs: config.idleTimeoutMs,
        fallback: existing.ttsService,
      },
      logger,
    );
    logger.info("Lab TTS enabled (stock provider is the fallback)");
  }
  if (config.sttUrl && providers.voiceStt.enabled !== false) {
    sttService = new LabSTT(
      {
        url: config.sttUrl,
        connectTimeoutMs: config.connectTimeoutMs,
        fallback: existing.sttService,
      },
      logger,
    );
    logger.info("Lab STT enabled (stock provider is the fallback)");
  }
  return { ...existing, ttsService, sttService };
}
