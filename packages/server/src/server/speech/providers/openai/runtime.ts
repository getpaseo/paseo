import type { Logger } from "pino";

import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import {
  DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_TTS_MODEL,
  type OpenAiSpeechProviderConfig,
} from "./config.js";
import { OpenAIRealtimeTranscriptionSession } from "./realtime-transcription-session.js";
import { OpenAISTT } from "./stt.js";
import { OpenAITTS } from "./tts.js";

type OpenAiCredentialState = {
  openaiSttApiKey: string | undefined;
  openaiTtsApiKey: string | undefined;
  openaiDictationApiKey: string | undefined;
};

export type OpenAiSpeechAvailability = {
  stt: boolean;
  tts: boolean;
  dictationStt: boolean;
};

export type SpeechServices = {
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
};

function resolveOpenAiCredentials(
  openaiConfig: OpenAiSpeechProviderConfig | undefined
): OpenAiCredentialState {
  const openaiApiKey = openaiConfig?.apiKey;
  return {
    openaiSttApiKey: openaiConfig?.stt?.apiKey ?? openaiApiKey,
    openaiTtsApiKey: openaiConfig?.tts?.apiKey ?? openaiApiKey,
    openaiDictationApiKey: openaiApiKey,
  };
}

export function getOpenAiSpeechAvailability(
  openaiConfig: OpenAiSpeechProviderConfig | undefined
): OpenAiSpeechAvailability {
  const credentials = resolveOpenAiCredentials(openaiConfig);
  return {
    stt: Boolean(credentials.openaiSttApiKey),
    tts: Boolean(credentials.openaiTtsApiKey),
    dictationStt: Boolean(credentials.openaiDictationApiKey),
  };
}

export function validateOpenAiCredentialRequirements(params: {
  providers: RequestedSpeechProviders;
  openaiConfig: OpenAiSpeechProviderConfig | undefined;
  logger: Logger;
}): void {
  const { providers, logger, openaiConfig } = params;
  const openAiCredentials = resolveOpenAiCredentials(openaiConfig);

  const missingOpenAiCredentialsFor: string[] = [];
  if (providers.voiceStt.provider === "openai" && !openAiCredentials.openaiSttApiKey) {
    missingOpenAiCredentialsFor.push("voice.stt");
  }
  if (providers.voiceTts.provider === "openai" && !openAiCredentials.openaiTtsApiKey) {
    missingOpenAiCredentialsFor.push("voice.tts");
  }
  if (
    providers.dictationStt.provider === "openai" &&
    !openAiCredentials.openaiDictationApiKey
  ) {
    missingOpenAiCredentialsFor.push("dictation.stt");
  }

  if (missingOpenAiCredentialsFor.length > 0) {
    logger.error(
      {
        requestedProviders: {
          dictationStt: providers.dictationStt.provider,
          voiceStt: providers.voiceStt.provider,
          voiceTts: providers.voiceTts.provider,
        },
        missingOpenAiCredentialsFor,
      },
      "Invalid speech configuration: OpenAI provider selected but credentials are missing"
    );
    throw new Error(
      `Missing OpenAI credentials for configured speech features: ${missingOpenAiCredentialsFor.join(", ")}`
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
  const openAiCredentials = resolveOpenAiCredentials(openaiConfig);

  let sttService = existing.sttService;
  let ttsService = existing.ttsService;
  let dictationSttService = existing.dictationSttService;

  const needsOpenAiStt = !sttService && providers.voiceStt.provider === "openai";
  const needsOpenAiTts = !ttsService && providers.voiceTts.provider === "openai";
  const needsOpenAiDictation =
    !dictationSttService && providers.dictationStt.provider === "openai";

  if (
    (needsOpenAiStt || needsOpenAiTts || needsOpenAiDictation) &&
    (openAiCredentials.openaiSttApiKey ||
      openAiCredentials.openaiTtsApiKey ||
      openAiCredentials.openaiDictationApiKey)
  ) {
    logger.info("OpenAI speech provider initialized");

    if (needsOpenAiStt && openAiCredentials.openaiSttApiKey) {
      const { apiKey: _sttApiKey, ...sttConfig } = openaiConfig?.stt ?? {};
      sttService = new OpenAISTT(
        {
          apiKey: openAiCredentials.openaiSttApiKey,
          ...sttConfig,
        },
        logger
      );
    }

    if (needsOpenAiTts && openAiCredentials.openaiTtsApiKey) {
      const { apiKey: _ttsApiKey, ...ttsConfig } = openaiConfig?.tts ?? {};
      ttsService = new OpenAITTS(
        {
          apiKey: openAiCredentials.openaiTtsApiKey,
          voice: "alloy",
          model: DEFAULT_OPENAI_TTS_MODEL,
          responseFormat: "pcm",
          ...ttsConfig,
        },
        logger
      );
    }

    const dictationApiKey = openAiCredentials.openaiDictationApiKey;
    if (needsOpenAiDictation && dictationApiKey) {
      dictationSttService = {
        id: "openai",
        createSession: ({ logger: sessionLogger, language, prompt }) =>
          new OpenAIRealtimeTranscriptionSession({
            apiKey: dictationApiKey,
            logger: sessionLogger,
            transcriptionModel:
              openaiConfig?.realtimeTranscriptionModel ??
              DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL,
            ...(language ? { language } : {}),
            ...(prompt ? { prompt } : {}),
            turnDetection: null,
          }),
      };
    }
  } else if (needsOpenAiStt || needsOpenAiTts || needsOpenAiDictation) {
    logger.warn("OpenAI speech providers are configured but credentials are missing");
  }

  return {
    sttService,
    ttsService,
    dictationSttService,
  };
}
