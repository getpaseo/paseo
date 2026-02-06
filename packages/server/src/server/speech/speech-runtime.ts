import type { Logger } from "pino";

import type { PaseoOpenAIConfig, PaseoSpeechConfig } from "../bootstrap.js";
import {
  getLocalSpeechAvailability,
  initializeLocalSpeechServices,
} from "./providers/local/runtime.js";
import type { LocalSpeechModelId } from "./providers/local/config.js";
import {
  getOpenAiSpeechAvailability,
  initializeOpenAiSpeechServices,
  validateOpenAiCredentialRequirements,
} from "./providers/openai/runtime.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import type { RequestedSpeechProviders } from "./speech-types.js";

function resolveRequestedSpeechProviders(
  speechConfig: PaseoSpeechConfig | null
): RequestedSpeechProviders {
  const fromConfig = speechConfig?.providers;
  if (fromConfig) {
    return fromConfig;
  }

  return {
    dictationStt: { provider: "local", explicit: false },
    voiceStt: { provider: "local", explicit: false },
    voiceTts: { provider: "local", explicit: false },
  };
}

export type InitializedSpeechRuntime = {
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
  cleanup: () => void;
  localModelConfig: {
    modelsDir: string;
    defaultModelIds: LocalSpeechModelId[];
  } | null;
};

export async function initializeSpeechRuntime(params: {
  logger: Logger;
  openaiConfig?: PaseoOpenAIConfig;
  speechConfig?: PaseoSpeechConfig;
}): Promise<InitializedSpeechRuntime> {
  const logger = params.logger;
  const speechConfig = params.speechConfig ?? null;
  const openaiConfig = params.openaiConfig;
  const providers = resolveRequestedSpeechProviders(speechConfig);

  validateOpenAiCredentialRequirements({
    providers,
    openaiConfig,
    logger,
  });

  logger.info(
    {
      requestedProviders: {
        dictationStt: providers.dictationStt.provider,
        voiceStt: providers.voiceStt.provider,
        voiceTts: providers.voiceTts.provider,
      },
      availability: {
        openai: getOpenAiSpeechAvailability(openaiConfig),
        local: getLocalSpeechAvailability(speechConfig),
      },
    },
    "Speech provider reconciliation started"
  );

  const localSpeech = await initializeLocalSpeechServices({
    providers,
    speechConfig,
    logger,
  });

  const openAiSpeech = initializeOpenAiSpeechServices({
    providers,
    openaiConfig,
    existing: {
      sttService: localSpeech.sttService,
      ttsService: localSpeech.ttsService,
      dictationSttService: localSpeech.dictationSttService,
    },
    logger,
  });

  const effectiveProviders = {
    dictationStt: openAiSpeech.dictationSttService?.id ?? "unavailable",
    voiceStt: openAiSpeech.sttService?.id ?? "unavailable",
    voiceTts:
      !openAiSpeech.ttsService
        ? "unavailable"
        : openAiSpeech.ttsService === localSpeech.localVoiceTtsProvider
          ? "local"
          : "openai",
  };
  const unavailableFeatures = [
    !openAiSpeech.dictationSttService ? "dictation.stt" : null,
    !openAiSpeech.sttService ? "voice.stt" : null,
    !openAiSpeech.ttsService ? "voice.tts" : null,
  ].filter((feature): feature is string => feature !== null);
  const explicitlyConfiguredUnavailableFeatures = unavailableFeatures.filter((feature) => {
    if (feature === "dictation.stt") {
      return providers.dictationStt.explicit;
    }
    if (feature === "voice.stt") {
      return providers.voiceStt.explicit;
    }
    return providers.voiceTts.explicit;
  });

  if (explicitlyConfiguredUnavailableFeatures.length > 0) {
    logger.error(
      {
        requestedProviders: {
          dictationStt: providers.dictationStt.provider,
          voiceStt: providers.voiceStt.provider,
          voiceTts: providers.voiceTts.provider,
        },
        explicitProviders: {
          dictationStt: providers.dictationStt.explicit,
          voiceStt: providers.voiceStt.explicit,
          voiceTts: providers.voiceTts.explicit,
        },
        effectiveProviders,
        unavailableFeatures: explicitlyConfiguredUnavailableFeatures,
      },
      "Speech provider reconciliation failed: configured features are unavailable"
    );
    throw new Error(
      `Configured speech features unavailable: ${explicitlyConfiguredUnavailableFeatures.join(", ")}`
    );
  }

  if (unavailableFeatures.length > 0) {
    logger.warn(
      {
        requestedProviders: {
          dictationStt: providers.dictationStt.provider,
          voiceStt: providers.voiceStt.provider,
          voiceTts: providers.voiceTts.provider,
        },
        explicitProviders: {
          dictationStt: providers.dictationStt.explicit,
          voiceStt: providers.voiceStt.explicit,
          voiceTts: providers.voiceTts.explicit,
        },
        effectiveProviders,
        unavailableFeatures,
      },
      "Speech provider reconciliation completed with unavailable default features"
    );
  } else {
    logger.info(
      {
        effectiveProviders,
      },
      "Speech provider reconciliation completed"
    );
  }

  return {
    sttService: openAiSpeech.sttService,
    ttsService: openAiSpeech.ttsService,
    dictationSttService: openAiSpeech.dictationSttService,
    cleanup: localSpeech.cleanup,
    localModelConfig: localSpeech.localModelConfig,
  };
}
