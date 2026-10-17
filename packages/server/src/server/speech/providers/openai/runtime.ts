import type { Logger } from "pino";

import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { TurnDetectionProvider } from "../../turn-detection-provider.js";
import { isOpenAiSpeechEndpointConfigured, type OpenAiSpeechProviderConfig } from "./config.js";
import { OpenAISTT } from "./stt.js";
import { OpenAITTS } from "./tts.js";

export interface OpenAiSpeechAvailability {
  stt: boolean;
  tts: boolean;
  dictationStt: boolean;
}

export interface SpeechServices {
  turnDetectionService: TurnDetectionProvider | null;
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
}

export function getOpenAiSpeechAvailability(
  openaiConfig: OpenAiSpeechProviderConfig | undefined,
): OpenAiSpeechAvailability {
  const stt = isOpenAiSpeechEndpointConfigured(openaiConfig?.stt);
  const tts = isOpenAiSpeechEndpointConfigured(openaiConfig?.tts);
  return { stt, tts, dictationStt: stt };
}

export function validateOpenAiCredentialRequirements(params: {
  providers: RequestedSpeechProviders;
  openaiConfig: OpenAiSpeechProviderConfig | undefined;
  logger: Logger;
}): void {
  const { providers, logger, openaiConfig } = params;
  const availability = getOpenAiSpeechAvailability(openaiConfig);

  const missingOpenAiCredentialsFor: string[] = [];
  if (
    providers.voiceStt.enabled !== false &&
    providers.voiceStt.provider === "openai" &&
    !availability.stt
  ) {
    missingOpenAiCredentialsFor.push("voice.stt");
  }
  if (
    providers.voiceTts.enabled !== false &&
    providers.voiceTts.provider === "openai" &&
    !availability.tts
  ) {
    missingOpenAiCredentialsFor.push("voice.tts");
  }
  if (
    providers.dictationStt.enabled !== false &&
    providers.dictationStt.provider === "openai" &&
    !availability.dictationStt
  ) {
    missingOpenAiCredentialsFor.push("dictation.stt");
  }

  if (missingOpenAiCredentialsFor.length > 0) {
    logger.warn(
      {
        requestedProviders: {
          dictationStt: providers.dictationStt.provider,
          voiceStt: providers.voiceStt.provider,
          voiceTts: providers.voiceTts.provider,
        },
        missingOpenAiCredentialsFor,
      },
      "Invalid speech configuration: OpenAI provider selected but credentials are missing — speech features will be unavailable",
    );
  }
}

export function initializeOpenAiSpeechServices(params: {
  providers: RequestedSpeechProviders;
  openaiConfig: OpenAiSpeechProviderConfig | undefined;
  existing: SpeechServices;
  logger: Logger;
}): SpeechServices {
  const { providers, openaiConfig, existing, logger } = params;
  const { stt, tts } = openaiConfig ?? {};

  let sttService = existing.sttService;
  let ttsService = existing.ttsService;
  let dictationSttService = existing.dictationSttService;
  const turnDetectionService = existing.turnDetectionService;

  const needsOpenAiStt =
    !sttService && providers.voiceStt.enabled !== false && providers.voiceStt.provider === "openai";
  const needsOpenAiTts =
    !ttsService && providers.voiceTts.enabled !== false && providers.voiceTts.provider === "openai";
  const needsOpenAiDictation =
    !dictationSttService &&
    providers.dictationStt.enabled !== false &&
    providers.dictationStt.provider === "openai";

  if (needsOpenAiStt && isOpenAiSpeechEndpointConfigured(stt)) {
    sttService = new OpenAISTT(stt, logger);
  }
  if (needsOpenAiTts && isOpenAiSpeechEndpointConfigured(tts)) {
    ttsService = new OpenAITTS(tts, logger);
  }
  if (needsOpenAiDictation && isOpenAiSpeechEndpointConfigured(stt)) {
    dictationSttService = new OpenAISTT(stt, logger);
  }

  return {
    turnDetectionService,
    sttService,
    ttsService,
    dictationSttService,
  };
}
