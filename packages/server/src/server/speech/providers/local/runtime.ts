import type { Logger } from "pino";

import type { PaseoSpeechConfig } from "../../../bootstrap.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import { PocketTtsOnnxTTS } from "./pocket/pocket-tts-onnx.js";
import {
  ensureLocalSpeechModels,
  getLocalSpeechModelDir,
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LocalSttModelIdSchema,
  LocalTtsModelIdSchema,
  type LocalSpeechModelId,
  type LocalSttModelId,
  type LocalTtsModelId,
} from "./models.js";
import { SherpaOfflineRecognizerEngine } from "./sherpa/sherpa-offline-recognizer.js";
import { SherpaOnlineRecognizerEngine } from "./sherpa/sherpa-online-recognizer.js";
import { SherpaOnnxParakeetSTT } from "./sherpa/sherpa-parakeet-stt.js";
import { SherpaParakeetRealtimeTranscriptionSession } from "./sherpa/sherpa-parakeet-realtime-session.js";
import { SherpaRealtimeTranscriptionSession } from "./sherpa/sherpa-realtime-session.js";
import { SherpaOnnxSTT } from "./sherpa/sherpa-stt.js";
import { SherpaOnnxTTS } from "./sherpa/sherpa-tts.js";

type LocalSttEngine =
  | { kind: "offline"; engine: SherpaOfflineRecognizerEngine }
  | { kind: "online"; engine: SherpaOnlineRecognizerEngine };

type ResolvedLocalModels = {
  dictationLocalSttModel: LocalSttModelId;
  voiceLocalSttModel: LocalSttModelId;
  voiceLocalTtsModel: LocalTtsModelId;
};

type LocalSpeechAvailability = {
  configured: boolean;
  modelsDir: string | null;
  autoDownload: boolean | null;
};

export type InitializedLocalSpeech = {
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
  localVoiceTtsProvider: TextToSpeechProvider | null;
  localModelConfig: {
    modelsDir: string;
    defaultModelIds: LocalSpeechModelId[];
  } | null;
  availability: LocalSpeechAvailability;
  cleanup: () => void;
};

function buildModelDownloadHint(modelId: LocalSpeechModelId): string {
  return `Use 'paseo speech download --model ${modelId}' to download this model.`;
}

function resolveConfiguredLocalModels(
  speechConfig: PaseoSpeechConfig | null
): ResolvedLocalModels {
  return {
    dictationLocalSttModel: LocalSttModelIdSchema.parse(
      speechConfig?.local?.models.dictationStt ?? DEFAULT_LOCAL_STT_MODEL
    ),
    voiceLocalSttModel: LocalSttModelIdSchema.parse(
      speechConfig?.local?.models.voiceStt ?? DEFAULT_LOCAL_STT_MODEL
    ),
    voiceLocalTtsModel: LocalTtsModelIdSchema.parse(
      speechConfig?.local?.models.voiceTts ?? DEFAULT_LOCAL_TTS_MODEL
    ),
  };
}

export function getLocalSpeechAvailability(
  speechConfig: PaseoSpeechConfig | null
): LocalSpeechAvailability {
  const localConfig = speechConfig?.local ?? null;
  return {
    configured: Boolean(localConfig),
    modelsDir: localConfig?.modelsDir ?? null,
    autoDownload: localConfig?.autoDownload ?? null,
  };
}

function computeRequiredLocalModelIds(params: {
  providers: RequestedSpeechProviders;
  models: ResolvedLocalModels;
}): LocalSpeechModelId[] {
  const ids = new Set<LocalSpeechModelId>();
  if (
    params.providers.dictationStt.enabled !== false &&
    params.providers.dictationStt.provider === "local"
  ) {
    ids.add(params.models.dictationLocalSttModel);
  }
  if (
    params.providers.voiceStt.enabled !== false &&
    params.providers.voiceStt.provider === "local"
  ) {
    ids.add(params.models.voiceLocalSttModel);
  }
  if (
    params.providers.voiceTts.enabled !== false &&
    params.providers.voiceTts.provider === "local"
  ) {
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

  if (modelId === "parakeet-tdt-0.6b-v3-int8" || modelId === "parakeet-tdt-0.6b-v2-int8") {
    const modelDir = getLocalSpeechModelDir(modelsDir, modelId);
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
    const modelDir = getLocalSpeechModelDir(modelsDir, modelId);
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
    const modelDir = getLocalSpeechModelDir(modelsDir, modelId);
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

export async function initializeLocalSpeechServices(params: {
  providers: RequestedSpeechProviders;
  speechConfig: PaseoSpeechConfig | null;
  logger: Logger;
  modelEnsureAutoDownload?: boolean;
}): Promise<InitializedLocalSpeech> {
  const { providers, logger, speechConfig } = params;
  const localConfig = speechConfig?.local ?? null;
  const localModels = resolveConfiguredLocalModels(speechConfig);
  const modelEnsureAutoDownload = params.modelEnsureAutoDownload ?? (localConfig?.autoDownload ?? true);

  let sttService: SpeechToTextProvider | null = null;
  let ttsService: TextToSpeechProvider | null = null;
  let dictationSttService: SpeechToTextProvider | null = null;
  let localVoiceTtsProvider: TextToSpeechProvider | null = null;

  const requiredLocalModelIds = computeRequiredLocalModelIds({
    providers,
    models: localModels,
  });

  if (requiredLocalModelIds.length > 0 && localConfig) {
    try {
      logger.info(
        {
          modelsDir: localConfig.modelsDir,
          modelIds: requiredLocalModelIds,
          autoDownload: modelEnsureAutoDownload,
        },
        "Ensuring local speech models"
      );
      await ensureLocalSpeechModels({
        modelsDir: localConfig.modelsDir,
        modelIds: requiredLocalModelIds,
        autoDownload: modelEnsureAutoDownload,
        logger,
      });
    } catch (err) {
      logger.error(
        {
          err,
          modelsDir: localConfig.modelsDir,
          modelIds: requiredLocalModelIds,
          autoDownload: modelEnsureAutoDownload,
          hint:
            "Use `paseo speech models` to inspect status and " +
            "`paseo speech download --model <MODEL_ID>` to fetch missing models.",
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
          hint: buildModelDownloadHint(modelId),
        },
        "Failed to initialize local STT engine (models missing or invalid)"
      );
      return null;
    }
  };

  if (providers.voiceStt.enabled !== false && providers.voiceStt.provider === "local") {
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

  if (providers.dictationStt.enabled !== false && providers.dictationStt.provider === "local") {
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

  if (providers.voiceTts.enabled !== false && providers.voiceTts.provider === "local") {
    if (!localConfig) {
      logger.warn(
        { configured: false },
        "Local TTS selected for voice but local provider config is missing; TTS will be unavailable"
      );
    } else {
      try {
        if (localModels.voiceLocalTtsModel === "pocket-tts-onnx-int8") {
          const modelDir = getLocalSpeechModelDir(localConfig.modelsDir, localModels.voiceLocalTtsModel);
          localVoiceTtsProvider = await PocketTtsOnnxTTS.create(
            {
              modelDir,
              precision: "int8",
              targetChunkMs: 50,
            },
            logger
          );
        } else {
          const modelDir = getLocalSpeechModelDir(localConfig.modelsDir, localModels.voiceLocalTtsModel);
          localVoiceTtsProvider = new SherpaOnnxTTS(
            {
              preset: localModels.voiceLocalTtsModel,
              modelDir,
              speakerId: speechConfig?.local?.models.voiceTtsSpeakerId,
              speed: speechConfig?.local?.models.voiceTtsSpeed,
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
            hint: buildModelDownloadHint(localModels.voiceLocalTtsModel),
          },
          "Failed to initialize local TTS engine (models missing or invalid)"
        );
      }
    }
  }

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
    localVoiceTtsProvider,
    localModelConfig:
      localConfig
        ? {
            modelsDir: localConfig.modelsDir,
            defaultModelIds: requiredLocalModelIds,
          }
        : null,
    availability: getLocalSpeechAvailability(speechConfig),
    cleanup,
  };
}
