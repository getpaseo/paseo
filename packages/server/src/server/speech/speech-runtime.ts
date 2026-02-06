import type { Logger } from "pino";

import type { PaseoOpenAIConfig, PaseoSpeechConfig } from "../bootstrap.js";
import {
  OpenAISTT,
} from "./providers/openai/stt.js";
import {
  OpenAITTS,
} from "./providers/openai/tts.js";
import { OpenAIRealtimeTranscriptionSession } from "./providers/openai/realtime-transcription-session.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import { SherpaOnlineRecognizerEngine } from "./providers/local/sherpa/sherpa-online-recognizer.js";
import { SherpaOfflineRecognizerEngine } from "./providers/local/sherpa/sherpa-offline-recognizer.js";
import { SherpaOnnxSTT } from "./providers/local/sherpa/sherpa-stt.js";
import { SherpaOnnxParakeetSTT } from "./providers/local/sherpa/sherpa-parakeet-stt.js";
import { SherpaOnnxTTS } from "./providers/local/sherpa/sherpa-tts.js";
import { SherpaRealtimeTranscriptionSession } from "./providers/local/sherpa/sherpa-realtime-session.js";
import { SherpaParakeetRealtimeTranscriptionSession } from "./providers/local/sherpa/sherpa-parakeet-realtime-session.js";
import { ensureSherpaOnnxModels, getSherpaOnnxModelDir } from "./providers/local/sherpa/model-downloader.js";
import {
  LocalSttModelIdSchema,
  LocalTtsModelIdSchema,
  type LocalSttModelId,
  type LocalTtsModelId,
  type SherpaOnnxModelId,
} from "./providers/local/sherpa/model-catalog.js";
import { PocketTtsOnnxTTS } from "./providers/local/pocket/pocket-tts-onnx.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL,
  type SpeechProviderId,
} from "./speech-types.js";

type LocalSttEngine =
  | { kind: "offline"; engine: SherpaOfflineRecognizerEngine }
  | { kind: "online"; engine: SherpaOnlineRecognizerEngine };

function buildModelDownloadHint(modelsDir: string, modelId: SherpaOnnxModelId): string {
  return `Run: tsx packages/server/scripts/download-speech-models.ts --models-dir '${modelsDir}' --model '${modelId}'`;
}

function resolveSpeechProviders(
  speechConfig: PaseoSpeechConfig | null
): {
  dictationSttProvider: SpeechProviderId;
  voiceSttProvider: SpeechProviderId;
  voiceTtsProvider: SpeechProviderId;
} {
  return {
    dictationSttProvider: speechConfig?.dictationSttProvider ?? "local",
    voiceSttProvider: speechConfig?.voiceSttProvider ?? "local",
    voiceTtsProvider: speechConfig?.voiceTtsProvider ?? "local",
  };
}

function resolveLocalModels(
  speechConfig: PaseoSpeechConfig | null
): {
  dictationLocalSttModel: LocalSttModelId;
  voiceLocalSttModel: LocalSttModelId;
  voiceLocalTtsModel: LocalTtsModelId;
} {
  return {
    dictationLocalSttModel: LocalSttModelIdSchema.parse(
      speechConfig?.dictationLocalSttModel ?? DEFAULT_LOCAL_STT_MODEL
    ),
    voiceLocalSttModel: LocalSttModelIdSchema.parse(
      speechConfig?.voiceLocalSttModel ?? DEFAULT_LOCAL_STT_MODEL
    ),
    voiceLocalTtsModel: LocalTtsModelIdSchema.parse(
      speechConfig?.voiceLocalTtsModel ?? DEFAULT_LOCAL_TTS_MODEL
    ),
  };
}

function computeDefaultLocalModelIds(params: {
  providers: {
    dictationSttProvider: SpeechProviderId;
    voiceSttProvider: SpeechProviderId;
    voiceTtsProvider: SpeechProviderId;
  };
  models: {
    dictationLocalSttModel: SherpaOnnxModelId;
    voiceLocalSttModel: SherpaOnnxModelId;
    voiceLocalTtsModel: SherpaOnnxModelId;
  };
}): SherpaOnnxModelId[] {
  const ids = new Set<SherpaOnnxModelId>();
  if (params.providers.dictationSttProvider === "local") {
    ids.add(params.models.dictationLocalSttModel);
  }
  if (params.providers.voiceSttProvider === "local") {
    ids.add(params.models.voiceLocalSttModel);
  }
  if (params.providers.voiceTtsProvider === "local") {
    ids.add(params.models.voiceLocalTtsModel);
  }
  return Array.from(ids);
}

async function createLocalSttEngine(params: {
  modelId: LocalSttModelId;
  modelsDir: string;
  logger: Logger;
}): Promise<LocalSttEngine> {
  const { modelId, modelsDir, logger } = params;

  if (modelId === "parakeet-tdt-0.6b-v3-int8") {
    const modelDir = getSherpaOnnxModelDir(modelsDir, modelId);
    return {
      kind: "offline",
      engine: new SherpaOfflineRecognizerEngine(
        {
          model: {
            kind: "nemo_transducer",
            encoder: `${modelDir}/encoder.int8.onnx`,
            decoder: `${modelDir}/decoder.int8.onnx`,
            joiner: `${modelDir}/joiner.int8.onnx`,
            tokens: `${modelDir}/tokens.txt`,
          },
          numThreads: 2,
          debug: 0,
        },
        logger
      ),
    };
  }

  if (modelId === "paraformer-bilingual-zh-en") {
    const modelDir = getSherpaOnnxModelDir(modelsDir, modelId);
    return {
      kind: "online",
      engine: new SherpaOnlineRecognizerEngine(
        {
          model: {
            kind: "paraformer",
            encoder: `${modelDir}/encoder.int8.onnx`,
            decoder: `${modelDir}/decoder.int8.onnx`,
            tokens: `${modelDir}/tokens.txt`,
          },
          numThreads: 1,
          debug: 0,
        },
        logger
      ),
    };
  }

  if (modelId === "zipformer-bilingual-zh-en-2023-02-20") {
    const modelDir = getSherpaOnnxModelDir(modelsDir, modelId);
    return {
      kind: "online",
      engine: new SherpaOnlineRecognizerEngine(
        {
          model: {
            kind: "transducer",
            encoder: `${modelDir}/encoder-epoch-99-avg-1.onnx`,
            decoder: `${modelDir}/decoder-epoch-99-avg-1.onnx`,
            joiner: `${modelDir}/joiner-epoch-99-avg-1.onnx`,
            tokens: `${modelDir}/tokens.txt`,
            modelType: "zipformer",
          },
          numThreads: 1,
          debug: 0,
        },
        logger
      ),
    };
  }

  throw new Error(`Unsupported local STT model '${modelId}'`);
}

export type InitializedSpeechRuntime = {
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
  cleanup: () => void;
  localModelConfig: {
    modelsDir: string;
    defaultModelIds: SherpaOnnxModelId[];
  } | null;
};

export async function initializeSpeechRuntime(params: {
  logger: Logger;
  openaiConfig?: PaseoOpenAIConfig;
  speechConfig?: PaseoSpeechConfig;
}): Promise<InitializedSpeechRuntime> {
  const logger = params.logger;
  const speechConfig = params.speechConfig ?? null;
  const localConfig = speechConfig?.local ?? null;
  const openaiConfig = params.openaiConfig;

  const providers = resolveSpeechProviders(speechConfig);
  const localModels = resolveLocalModels(speechConfig);

  const wantsLocalDictation = providers.dictationSttProvider === "local";
  const wantsLocalVoiceStt = providers.voiceSttProvider === "local";
  const wantsLocalVoiceTts = providers.voiceTtsProvider === "local";

  const openaiApiKey = openaiConfig?.apiKey;
  const openaiSttApiKey = openaiConfig?.stt?.apiKey ?? openaiApiKey;
  const openaiTtsApiKey = openaiConfig?.tts?.apiKey ?? openaiApiKey;
  const openaiDictationApiKey = openaiApiKey;

  const missingOpenAiCredentialsFor: string[] = [];
  if (providers.voiceSttProvider === "openai" && !openaiSttApiKey) {
    missingOpenAiCredentialsFor.push("voice.stt");
  }
  if (providers.voiceTtsProvider === "openai" && !openaiTtsApiKey) {
    missingOpenAiCredentialsFor.push("voice.tts");
  }
  if (providers.dictationSttProvider === "openai" && !openaiDictationApiKey) {
    missingOpenAiCredentialsFor.push("dictation.stt");
  }
  if (missingOpenAiCredentialsFor.length > 0) {
    logger.error(
      {
        requestedProviders: {
          dictationStt: providers.dictationSttProvider,
          voiceStt: providers.voiceSttProvider,
          voiceTts: providers.voiceTtsProvider,
        },
        missingOpenAiCredentialsFor,
      },
      "Invalid speech configuration: OpenAI provider selected but credentials are missing"
    );
    throw new Error(
      `Missing OpenAI credentials for configured speech features: ${missingOpenAiCredentialsFor.join(", ")}`
    );
  }

  logger.info(
    {
      requestedProviders: {
        dictationStt: providers.dictationSttProvider,
        voiceStt: providers.voiceSttProvider,
        voiceTts: providers.voiceTtsProvider,
      },
      availability: {
        openai: {
          stt: Boolean(openaiSttApiKey),
          tts: Boolean(openaiTtsApiKey),
          dictationStt: Boolean(openaiDictationApiKey),
        },
        local: {
          configured: Boolean(localConfig),
          modelsDir: localConfig?.modelsDir ?? null,
          autoDownload: localConfig?.autoDownload ?? null,
        },
      },
    },
    "Speech provider reconciliation started"
  );

  let sttService: SpeechToTextProvider | null = null;
  let ttsService: TextToSpeechProvider | null = null;
  let dictationSttService: SpeechToTextProvider | null = null;
  let localVoiceTtsProvider: TextToSpeechProvider | null = null;

  const requiredLocalModelIds = computeDefaultLocalModelIds({
    providers,
    models: localModels,
  });

  if (requiredLocalModelIds.length > 0 && localConfig) {
    try {
      logger.info(
        {
          modelsDir: localConfig.modelsDir,
          modelIds: requiredLocalModelIds,
          autoDownload: localConfig.autoDownload ?? true,
        },
        "Ensuring local speech models"
      );
      await ensureSherpaOnnxModels({
        modelsDir: localConfig.modelsDir,
        modelIds: requiredLocalModelIds,
        autoDownload: localConfig.autoDownload ?? true,
        logger,
      });
    } catch (err) {
      logger.error(
        {
          err,
          modelsDir: localConfig.modelsDir,
          modelIds: requiredLocalModelIds,
          autoDownload: localConfig.autoDownload ?? true,
          hint:
            "Run: npm run dev --workspace=@getpaseo/server, then run: " +
            "`tsx packages/server/scripts/download-speech-models.ts --models-dir <DIR> --model <MODEL_ID>`",
        },
        "Failed to ensure local speech models"
      );
    }
  }

  const localSttEngines = new Map<LocalSttModelId, LocalSttEngine>();
  const getLocalSttEngine = async (
    modelId: LocalSttModelId
  ): Promise<LocalSttEngine | null> => {
    const existing = localSttEngines.get(modelId);
    if (existing) {
      return existing;
    }
    if (!localConfig) {
      return null;
    }
    try {
      const created = await createLocalSttEngine({
        modelId,
        modelsDir: localConfig.modelsDir,
        logger,
      });
      localSttEngines.set(modelId, created);
      return created;
    } catch (err) {
      logger.error(
        {
          err,
          modelsDir: localConfig.modelsDir,
          modelId,
          hint: buildModelDownloadHint(localConfig.modelsDir, modelId),
        },
        "Failed to initialize local STT engine (models missing or invalid)"
      );
      return null;
    }
  };

  if (wantsLocalVoiceStt) {
    if (!localConfig) {
      logger.warn(
        { configured: false },
        "Local STT selected for voice but local provider config is missing; STT will be unavailable"
      );
    } else {
      const voiceEngine = await getLocalSttEngine(localModels.voiceLocalSttModel);
      if (voiceEngine?.kind === "offline") {
        sttService = new SherpaOnnxParakeetSTT({ engine: voiceEngine.engine }, logger);
      } else if (voiceEngine?.kind === "online") {
        sttService = new SherpaOnnxSTT({ engine: voiceEngine.engine }, logger);
      }
    }
  }

  if (wantsLocalDictation) {
    if (!localConfig) {
      logger.warn(
        { configured: false },
        "Local STT selected for dictation but local provider config is missing; dictation STT will be unavailable"
      );
    } else {
      const dictationEngine = await getLocalSttEngine(localModels.dictationLocalSttModel);
      if (dictationEngine?.kind === "offline") {
        dictationSttService = {
          id: "local",
          createSession: () =>
            new SherpaParakeetRealtimeTranscriptionSession({ engine: dictationEngine.engine }),
        };
      } else if (dictationEngine?.kind === "online") {
        dictationSttService = {
          id: "local",
          createSession: () => new SherpaRealtimeTranscriptionSession({ engine: dictationEngine.engine }),
        };
      }
    }
  }

  if (wantsLocalVoiceTts) {
    if (!localConfig) {
      logger.warn(
        { configured: false },
        "Local TTS selected for voice but local provider config is missing; TTS will be unavailable"
      );
    } else {
      try {
        if (localModels.voiceLocalTtsModel === "pocket-tts-onnx-int8") {
          const modelDir = getSherpaOnnxModelDir(localConfig.modelsDir, localModels.voiceLocalTtsModel);
          localVoiceTtsProvider = await PocketTtsOnnxTTS.create(
            {
              modelDir,
              precision: "int8",
              targetChunkMs: 50,
            },
            logger
          );
        } else {
          const modelDir = getSherpaOnnxModelDir(localConfig.modelsDir, localModels.voiceLocalTtsModel);
          localVoiceTtsProvider = new SherpaOnnxTTS(
            {
              preset: localModels.voiceLocalTtsModel,
              modelDir,
              speakerId: speechConfig?.voiceLocalTtsSpeakerId,
              speed: speechConfig?.voiceLocalTtsSpeed,
            },
            logger
          );
        }
        ttsService = localVoiceTtsProvider;
      } catch (err) {
        logger.error(
          {
            err,
            modelsDir: localConfig.modelsDir,
            modelId: localModels.voiceLocalTtsModel,
            hint: buildModelDownloadHint(localConfig.modelsDir, localModels.voiceLocalTtsModel),
          },
          "Failed to initialize local TTS engine (models missing or invalid)"
        );
      }
    }
  }

  const needsOpenAiStt = !sttService && providers.voiceSttProvider === "openai";
  const needsOpenAiTts = !ttsService && providers.voiceTtsProvider === "openai";
  const needsOpenAiDictation = !dictationSttService && providers.dictationSttProvider === "openai";

  if (
    (needsOpenAiStt || needsOpenAiTts || needsOpenAiDictation) &&
    (openaiSttApiKey || openaiTtsApiKey || openaiDictationApiKey)
  ) {
    logger.info("OpenAI speech provider initialized");

    if (needsOpenAiStt && openaiSttApiKey) {
      const { apiKey: _sttApiKey, ...sttConfig } = openaiConfig?.stt ?? {};
      sttService = new OpenAISTT(
        {
          apiKey: openaiSttApiKey,
          ...sttConfig,
        },
        logger
      );
    }

    if (needsOpenAiTts && openaiTtsApiKey) {
      const { apiKey: _ttsApiKey, ...ttsConfig } = openaiConfig?.tts ?? {};
      ttsService = new OpenAITTS(
        {
          apiKey: openaiTtsApiKey,
          voice: "alloy",
          model: "tts-1",
          responseFormat: "pcm",
          ...ttsConfig,
        },
        logger
      );
    }

    if (needsOpenAiDictation && openaiDictationApiKey) {
      dictationSttService = {
        id: "openai",
        createSession: ({ logger: sessionLogger, language, prompt }) =>
          new OpenAIRealtimeTranscriptionSession({
            apiKey: openaiDictationApiKey,
            logger: sessionLogger,
            transcriptionModel:
              openaiConfig?.realtimeTranscriptionModel
              ?? DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL,
            ...(language ? { language } : {}),
            ...(prompt ? { prompt } : {}),
            turnDetection: null,
          }),
      };
    }
  } else if (needsOpenAiStt || needsOpenAiTts || needsOpenAiDictation) {
    logger.warn("OpenAI speech providers are configured but credentials are missing");
  }

  const effectiveProviders = {
    dictationStt: dictationSttService?.id ?? "unavailable",
    voiceStt: sttService?.id ?? "unavailable",
    voiceTts: !ttsService ? "unavailable" : ttsService === localVoiceTtsProvider ? "local" : "openai",
  };
  const unavailableFeatures = [
    !dictationSttService ? "dictation.stt" : null,
    !sttService ? "voice.stt" : null,
    !ttsService ? "voice.tts" : null,
  ].filter((feature): feature is string => feature !== null);

  if (unavailableFeatures.length > 0) {
    logger.error(
      {
        requestedProviders: {
          dictationStt: providers.dictationSttProvider,
          voiceStt: providers.voiceSttProvider,
          voiceTts: providers.voiceTtsProvider,
        },
        effectiveProviders,
        unavailableFeatures,
      },
      "Speech provider reconciliation failed: configured features are unavailable"
    );
    throw new Error(`Configured speech features unavailable: ${unavailableFeatures.join(", ")}`);
  }

  logger.info(
    {
      effectiveProviders,
    },
    "Speech provider reconciliation completed"
  );

  const cleanup = () => {
    const maybeFreeable = localVoiceTtsProvider as unknown as { free?: () => void } | null;
    if (typeof maybeFreeable?.free === "function") {
      maybeFreeable.free();
    }
    for (const engine of localSttEngines.values()) {
      engine.engine.free();
    }
  };

  return {
    sttService,
    ttsService,
    dictationSttService,
    cleanup,
    localModelConfig:
      localConfig
        ? {
            modelsDir: localConfig.modelsDir,
            defaultModelIds: requiredLocalModelIds,
          }
        : null,
  };
}
