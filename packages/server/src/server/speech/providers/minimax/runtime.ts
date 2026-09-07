import type { Logger } from "pino";

import type { TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { MiniMaxSpeechProviderConfig } from "./config.js";
import { MiniMaxTTS } from "./tts.js";

export function getMiniMaxSpeechAvailability(config: MiniMaxSpeechProviderConfig | undefined): {
  tts: boolean;
} {
  return { tts: Boolean(config?.tts?.apiKey) };
}

export function initializeMiniMaxTts(params: {
  providers: RequestedSpeechProviders;
  config: MiniMaxSpeechProviderConfig | undefined;
  existing: TextToSpeechProvider | null;
  logger: Logger;
}): { service: TextToSpeechProvider | null; provider: MiniMaxTTS | null } {
  const needsMiniMax =
    !params.existing &&
    params.providers.voiceTts.enabled !== false &&
    params.providers.voiceTts.provider === "minimax";
  const apiKey = params.config?.tts?.apiKey;
  if (!needsMiniMax || !apiKey) {
    if (needsMiniMax) {
      params.logger.warn(
        "Invalid speech configuration: MiniMax provider selected but credentials are missing",
      );
    }
    return { service: params.existing, provider: null };
  }

  const { apiKey: _apiKey, ...config } = params.config?.tts ?? {};
  const provider = new MiniMaxTTS({ apiKey, ...config }, params.logger);
  params.logger.info("MiniMax speech provider initialized");
  return { service: provider, provider };
}
