import type { Logger } from "pino";

import type { TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { MiniMaxSpeechProviderConfig } from "./config.js";
import { DEFAULT_MINIMAX_TTS_MODEL, DEFAULT_MINIMAX_TTS_VOICE } from "./config.js";
import { MiniMaxTTS } from "./tts.js";

export type MiniMaxSpeechServices = {
  ttsService: TextToSpeechProvider | null;
};

export function initializeMiniMaxSpeechServices(params: {
  providers: RequestedSpeechProviders;
  minimaxConfig: MiniMaxSpeechProviderConfig | undefined;
  existing: { ttsService: TextToSpeechProvider | null };
  logger: Logger;
}): MiniMaxSpeechServices {
  const { providers, minimaxConfig, existing, logger } = params;

  let ttsService = existing.ttsService;

  const needsMiniMaxTts =
    !ttsService &&
    providers.voiceTts.enabled !== false &&
    providers.voiceTts.provider === "minimax";

  if (needsMiniMaxTts) {
    if (!minimaxConfig?.apiKey) {
      logger.warn("MiniMax TTS provider is configured but MINIMAX_API_KEY is missing");
    } else {
      const { apiKey: _ttsApiKey, ...ttsConfig } = minimaxConfig.tts ?? {};
      ttsService = new MiniMaxTTS(
        {
          apiKey: minimaxConfig.apiKey,
          model: DEFAULT_MINIMAX_TTS_MODEL,
          voice: DEFAULT_MINIMAX_TTS_VOICE,
          ...ttsConfig,
        },
        logger,
      );
      logger.info("MiniMax TTS provider initialized");
    }
  }

  return { ttsService };
}
