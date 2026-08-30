import type { Logger } from "pino";

import type { SpeechServices } from "../../speech-provider.js";
import type { RequestedSpeechProvider, RequestedSpeechProviders } from "../../speech-types.js";
import type { GeminiSpeechProviderConfig } from "./config.js";
import { GeminiSTT } from "./stt.js";
import { GeminiTTS } from "./tts.js";

function isGeminiEnabled(provider: RequestedSpeechProvider): boolean {
  return provider.enabled !== false && provider.provider === "gemini";
}

export function validateGeminiCredentialRequirements(params: {
  providers: RequestedSpeechProviders;
  config: GeminiSpeechProviderConfig | undefined;
  logger: Logger;
}): void {
  if (params.config) {
    return;
  }

  const requirements = [
    { feature: "voice.stt", provider: params.providers.voiceStt },
    { feature: "dictation.stt", provider: params.providers.dictationStt },
    { feature: "voice.tts", provider: params.providers.voiceTts },
  ];
  const missingCredentialsFor = requirements
    .filter(({ provider }) => isGeminiEnabled(provider))
    .map(({ feature }) => feature);

  if (missingCredentialsFor.length > 0) {
    params.logger.warn(
      { missingCredentialsFor },
      "Invalid speech configuration: Gemini provider selected but credentials are missing",
    );
  }
}

export function initializeGeminiSpeechServices(params: {
  providers: RequestedSpeechProviders;
  config: GeminiSpeechProviderConfig | undefined;
  existing: SpeechServices;
  logger: Logger;
}): SpeechServices {
  const { providers, config, existing, logger } = params;
  if (!config) {
    return existing;
  }

  return {
    ...existing,
    sttService:
      existing.sttService ??
      (isGeminiEnabled(providers.voiceStt)
        ? new GeminiSTT({ apiKey: config.apiKey, config: config.voiceStt, logger })
        : null),
    ttsService:
      existing.ttsService ??
      (isGeminiEnabled(providers.voiceTts)
        ? new GeminiTTS({ apiKey: config.apiKey, config: config.tts, logger })
        : null),
    dictationSttService:
      existing.dictationSttService ??
      (isGeminiEnabled(providers.dictationStt)
        ? new GeminiSTT({ apiKey: config.apiKey, config: config.dictationStt, logger })
        : null),
  };
}
