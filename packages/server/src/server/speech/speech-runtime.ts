import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import type { PaseoOpenAIConfig, PaseoSpeechConfig } from "../bootstrap.js";
import type { LocalSpeechModelId } from "./providers/local/config.js";
import {
  ensureLocalSpeechModels,
  getLocalSpeechModelDir,
  listLocalSpeechModels,
} from "./providers/local/models.js";
import { initializeLocalSpeechServices } from "./providers/local/runtime.js";
import {
  getOpenAiSpeechAvailability,
  initializeOpenAiSpeechServices,
  validateOpenAiCredentialRequirements,
} from "./providers/openai/runtime.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import type { RequestedSpeechProviders } from "./speech-types.js";

const SPEECH_RUNTIME_MONITOR_INTERVAL_MS = 3000;

export type SpeechReadinessReasonCode =
  | "ready"
  | "disabled"
  | "model_download_in_progress"
  | "models_missing"
  | "model_download_failed"
  | "stt_unavailable"
  | "tts_unavailable";

export type SpeechReadinessState = {
  enabled: boolean;
  available: boolean;
  reasonCode: SpeechReadinessReasonCode;
  message: string;
  retryable: boolean;
  missingModelIds: LocalSpeechModelId[];
};

export type SpeechReadinessSnapshot = {
  generatedAt: string;
  requiredLocalModelIds: LocalSpeechModelId[];
  missingLocalModelIds: LocalSpeechModelId[];
  download: {
    inProgress: boolean;
    error: string | null;
  };
  realtimeVoice: SpeechReadinessState;
  dictation: SpeechReadinessState;
  voiceFeature: SpeechReadinessState;
};

function resolveRequestedSpeechProviders(
  speechConfig: PaseoSpeechConfig | null
): RequestedSpeechProviders {
  const fromConfig = speechConfig?.providers;
  if (fromConfig) {
    return fromConfig;
  }

  return {
    dictationStt: { provider: "local", explicit: false, enabled: true },
    voiceStt: { provider: "local", explicit: false, enabled: true },
    voiceTts: { provider: "local", explicit: false, enabled: true },
  };
}

async function hasRequiredLocalModelFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      return true;
    }
    return fileStat.isFile() && fileStat.size > 0;
  } catch {
    return false;
  }
}

async function findMissingRequiredLocalModels(params: {
  modelsDir: string | null;
  requiredModelIds: LocalSpeechModelId[];
}): Promise<LocalSpeechModelId[]> {
  const { modelsDir, requiredModelIds } = params;
  if (!modelsDir || requiredModelIds.length === 0) {
    return [];
  }

  const specsById = new Map(listLocalSpeechModels().map((model) => [model.id, model]));
  const missing = new Set<LocalSpeechModelId>();

  for (const modelId of requiredModelIds) {
    const spec = specsById.get(modelId);
    if (!spec) {
      missing.add(modelId);
      continue;
    }
    const modelDir = getLocalSpeechModelDir(modelsDir, modelId);
    for (const relPath of spec.requiredFiles) {
      const filePath = join(modelDir, relPath);
      if (!(await hasRequiredLocalModelFile(filePath))) {
        missing.add(modelId);
        break;
      }
    }
  }

  return Array.from(missing);
}

function joinModelIds(modelIds: LocalSpeechModelId[]): string {
  if (modelIds.length === 0) {
    return "none";
  }
  return modelIds.join(", ");
}

function buildRealtimeVoiceReadiness(params: {
  providers: RequestedSpeechProviders;
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
}): SpeechReadinessState {
  const voiceSttEnabled = params.providers.voiceStt.enabled !== false;
  const voiceTtsEnabled = params.providers.voiceTts.enabled !== false;
  const enabled = voiceSttEnabled || voiceTtsEnabled;
  if (!enabled) {
    return {
      enabled: false,
      available: false,
      reasonCode: "disabled",
      message: "Realtime voice is disabled in daemon config.",
      retryable: false,
      missingModelIds: [],
    };
  }
  if (voiceSttEnabled && !params.sttService) {
    return {
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Realtime voice is unavailable: speech-to-text service is not ready.",
      retryable: false,
      missingModelIds: [],
    };
  }
  if (voiceTtsEnabled && !params.ttsService) {
    return {
      enabled: true,
      available: false,
      reasonCode: "tts_unavailable",
      message: "Realtime voice is unavailable: text-to-speech service is not ready.",
      retryable: false,
      missingModelIds: [],
    };
  }
  return {
    enabled: true,
    available: true,
    reasonCode: "ready",
    message: "Realtime voice is ready.",
    retryable: false,
    missingModelIds: [],
  };
}

function buildDictationReadiness(params: {
  providers: RequestedSpeechProviders;
  dictationSttService: SpeechToTextProvider | null;
}): SpeechReadinessState {
  const enabled = params.providers.dictationStt.enabled !== false;
  if (!enabled) {
    return {
      enabled: false,
      available: false,
      reasonCode: "disabled",
      message: "Dictation is disabled in daemon config.",
      retryable: false,
      missingModelIds: [],
    };
  }
  if (!params.dictationSttService) {
    return {
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Dictation is unavailable: speech-to-text service is not ready.",
      retryable: false,
      missingModelIds: [],
    };
  }
  return {
    enabled: true,
    available: true,
    reasonCode: "ready",
    message: "Dictation is ready.",
    retryable: false,
    missingModelIds: [],
  };
}

function buildVoiceFeatureReadiness(params: {
  realtimeVoice: SpeechReadinessState;
  dictation: SpeechReadinessState;
  missingLocalModelIds: LocalSpeechModelId[];
  backgroundDownloadInProgress: boolean;
  backgroundDownloadError: string | null;
  localAutoDownloadEnabled: boolean;
}): SpeechReadinessState {
  const enabled = params.realtimeVoice.enabled || params.dictation.enabled;
  if (!enabled) {
    return {
      enabled: false,
      available: false,
      reasonCode: "disabled",
      message: "Voice features are disabled in daemon config.",
      retryable: false,
      missingModelIds: [],
    };
  }

  if (params.missingLocalModelIds.length > 0) {
    const missingModelIds = [...params.missingLocalModelIds];
    if (params.backgroundDownloadInProgress) {
      return {
        enabled: true,
        available: false,
        reasonCode: "model_download_in_progress",
        message: `Voice features are unavailable while models download in the background (${joinModelIds(missingModelIds)}).`,
        retryable: true,
        missingModelIds,
      };
    }
    if (params.backgroundDownloadError) {
      return {
        enabled: true,
        available: false,
        reasonCode: "model_download_failed",
        message: `Voice features are unavailable: model download failed (${params.backgroundDownloadError}).`,
        retryable: false,
        missingModelIds,
      };
    }
    return {
      enabled: true,
      available: false,
      reasonCode: "models_missing",
      message: `Voice features are unavailable: missing local models (${joinModelIds(missingModelIds)}).`,
      retryable: params.localAutoDownloadEnabled,
      missingModelIds,
    };
  }

  return {
    enabled: true,
    available: true,
    reasonCode: "ready",
    message: "Voice features are ready.",
    retryable: false,
    missingModelIds: [],
  };
}

function describeRequestedProviders(providers: RequestedSpeechProviders): {
  dictationStt: { provider: string; enabled: boolean; explicit: boolean };
  voiceStt: { provider: string; enabled: boolean; explicit: boolean };
  voiceTts: { provider: string; enabled: boolean; explicit: boolean };
} {
  return {
    dictationStt: {
      provider: providers.dictationStt.provider,
      enabled: providers.dictationStt.enabled !== false,
      explicit: providers.dictationStt.explicit,
    },
    voiceStt: {
      provider: providers.voiceStt.provider,
      enabled: providers.voiceStt.enabled !== false,
      explicit: providers.voiceStt.explicit,
    },
    voiceTts: {
      provider: providers.voiceTts.provider,
      enabled: providers.voiceTts.enabled !== false,
      explicit: providers.voiceTts.explicit,
    },
  };
}

function resolveEffectiveProviderIds(params: {
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
  localVoiceTtsProvider: TextToSpeechProvider | null;
}): { dictationStt: string; voiceStt: string; voiceTts: string } {
  return {
    dictationStt: params.dictationSttService?.id ?? "unavailable",
    voiceStt: params.sttService?.id ?? "unavailable",
    voiceTts:
      !params.ttsService
        ? "unavailable"
        : params.ttsService === params.localVoiceTtsProvider
          ? "local"
          : "openai",
  };
}

export type InitializedSpeechRuntime = {
  resolveVoiceStt: () => SpeechToTextProvider | null;
  resolveVoiceTts: () => TextToSpeechProvider | null;
  resolveDictationStt: () => SpeechToTextProvider | null;
  getSpeechReadiness: () => SpeechReadinessSnapshot;
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
  const logger = params.logger.child({ module: "speech-runtime" });
  const speechConfig = params.speechConfig ?? null;
  const openaiConfig = params.openaiConfig;
  const providers = resolveRequestedSpeechProviders(speechConfig);
  const requestedProviders = describeRequestedProviders(providers);
  const localAutoDownloadEnabled = speechConfig?.local?.autoDownload ?? true;

  validateOpenAiCredentialRequirements({
    providers,
    openaiConfig,
    logger,
  });

  logger.info(
    {
      requestedProviders,
      availability: {
        openai: getOpenAiSpeechAvailability(openaiConfig),
      },
    },
    "Speech provider reconciliation started"
  );

  let sttService: SpeechToTextProvider | null = null;
  let ttsService: TextToSpeechProvider | null = null;
  let dictationSttService: SpeechToTextProvider | null = null;
  let localModelConfig: {
    modelsDir: string;
    defaultModelIds: LocalSpeechModelId[];
  } | null = null;
  let localCleanup = () => {};
  let localVoiceTtsProvider: TextToSpeechProvider | null = null;

  let missingLocalModelIds: LocalSpeechModelId[] = [];
  let backgroundDownloadInProgress = false;
  let backgroundDownloadError: string | null = null;
  let stopped = false;
  let monitorTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconcileInFlight: Promise<void> | null = null;

  const computeReadinessSnapshot = (): SpeechReadinessSnapshot => {
    const realtimeVoice = buildRealtimeVoiceReadiness({
      providers,
      sttService,
      ttsService,
    });
    const dictation = buildDictationReadiness({
      providers,
      dictationSttService,
    });
    const voiceFeature = buildVoiceFeatureReadiness({
      realtimeVoice,
      dictation,
      missingLocalModelIds,
      backgroundDownloadInProgress,
      backgroundDownloadError,
      localAutoDownloadEnabled,
    });
    return {
      generatedAt: new Date().toISOString(),
      requiredLocalModelIds: localModelConfig?.defaultModelIds ?? [],
      missingLocalModelIds: [...missingLocalModelIds],
      download: {
        inProgress: backgroundDownloadInProgress,
        error: backgroundDownloadError,
      },
      realtimeVoice: {
        ...realtimeVoice,
      },
      dictation: {
        ...dictation,
      },
      voiceFeature: {
        ...voiceFeature,
      },
    };
  };

  const refreshMissingLocalModels = async (): Promise<void> => {
    missingLocalModelIds = await findMissingRequiredLocalModels({
      modelsDir: localModelConfig?.modelsDir ?? null,
      requiredModelIds: localModelConfig?.defaultModelIds ?? [],
    });
  };

  const reconcileServices = async (modelEnsureAutoDownload: boolean): Promise<void> => {
    const nextLocalSpeech = await initializeLocalSpeechServices({
      providers,
      speechConfig,
      logger,
      modelEnsureAutoDownload,
    });
    const nextOpenAiSpeech = initializeOpenAiSpeechServices({
      providers,
      openaiConfig,
      existing: {
        sttService: nextLocalSpeech.sttService,
        ttsService: nextLocalSpeech.ttsService,
        dictationSttService: nextLocalSpeech.dictationSttService,
      },
      logger,
    });

    const previousLocalCleanup = localCleanup;
    sttService = nextOpenAiSpeech.sttService;
    ttsService = nextOpenAiSpeech.ttsService;
    dictationSttService = nextOpenAiSpeech.dictationSttService;
    localModelConfig = nextLocalSpeech.localModelConfig;
    localVoiceTtsProvider = nextLocalSpeech.localVoiceTtsProvider;
    localCleanup = nextLocalSpeech.cleanup;
    previousLocalCleanup();

    await refreshMissingLocalModels();

    const effectiveProviders = resolveEffectiveProviderIds({
      sttService,
      ttsService,
      dictationSttService,
      localVoiceTtsProvider,
    });
    const unavailableFeatures = [
      providers.dictationStt.enabled !== false && !dictationSttService ? "dictation.stt" : null,
      providers.voiceStt.enabled !== false && !sttService ? "voice.stt" : null,
      providers.voiceTts.enabled !== false && !ttsService ? "voice.tts" : null,
    ].filter((feature): feature is string => feature !== null);

    if (unavailableFeatures.length > 0) {
      logger.warn(
        {
          requestedProviders,
          effectiveProviders,
          unavailableFeatures,
          missingLocalModelIds,
        },
        "Speech provider reconciliation completed with unavailable features"
      );
    } else {
      logger.info(
        {
          requestedProviders,
          effectiveProviders,
        },
        "Speech provider reconciliation completed"
      );
    }
  };

  const runReconcile = async (params: { modelEnsureAutoDownload: boolean }): Promise<void> => {
    if (reconcileInFlight) {
      await reconcileInFlight;
      return;
    }
    reconcileInFlight = reconcileServices(params.modelEnsureAutoDownload).finally(() => {
      reconcileInFlight = null;
    });
    await reconcileInFlight;
  };

  const scheduleMonitor = (): void => {
    if (stopped || monitorTimeout) {
      return;
    }
    monitorTimeout = setTimeout(() => {
      monitorTimeout = null;
      void runMonitorTick();
    }, SPEECH_RUNTIME_MONITOR_INTERVAL_MS);
  };

  const startBackgroundDownload = (): void => {
    if (stopped || backgroundDownloadInProgress) {
      return;
    }
    const modelsDir = localModelConfig?.modelsDir ?? null;
    const modelIds = [...missingLocalModelIds];
    if (!modelsDir || modelIds.length === 0 || !localAutoDownloadEnabled) {
      return;
    }

    backgroundDownloadInProgress = true;
    backgroundDownloadError = null;

    logger.info(
      {
        modelsDir,
        modelIds,
      },
      "Starting background download for missing local speech models"
    );

    void (async () => {
      try {
        await ensureLocalSpeechModels({
          modelsDir,
          modelIds,
          autoDownload: true,
          logger,
        });
        await runReconcile({ modelEnsureAutoDownload: false });
        backgroundDownloadError = null;
      } catch (error) {
        backgroundDownloadError = error instanceof Error ? error.message : String(error);
        logger.error(
          {
            err: error,
            modelIds,
          },
          "Background local speech model download failed"
        );
      } finally {
        backgroundDownloadInProgress = false;
        await refreshMissingLocalModels().catch((error) => {
          logger.warn({ err: error }, "Failed to refresh local speech model status after download");
        });
        scheduleMonitor();
      }
    })();
  };

  const runMonitorTick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      await refreshMissingLocalModels();
      const snapshot = computeReadinessSnapshot();
      if (
        snapshot.voiceFeature.enabled &&
        !snapshot.voiceFeature.available &&
        missingLocalModelIds.length === 0 &&
        !backgroundDownloadInProgress
      ) {
        await runReconcile({ modelEnsureAutoDownload: false });
      }

      if (
        missingLocalModelIds.length > 0 &&
        localAutoDownloadEnabled &&
        !backgroundDownloadInProgress &&
        !backgroundDownloadError
      ) {
        startBackgroundDownload();
      }
    } catch (error) {
      logger.warn({ err: error }, "Speech runtime monitor tick failed");
    } finally {
      scheduleMonitor();
    }
  };

  await runReconcile({ modelEnsureAutoDownload: false });
  const snapshot = computeReadinessSnapshot();
  if (snapshot.voiceFeature.enabled && !snapshot.voiceFeature.available) {
    if (missingLocalModelIds.length > 0 && localAutoDownloadEnabled) {
      startBackgroundDownload();
    }
    scheduleMonitor();
  }

  const cleanup = (): void => {
    stopped = true;
    if (monitorTimeout) {
      clearTimeout(monitorTimeout);
      monitorTimeout = null;
    }
    localCleanup();
  };

  return {
    resolveVoiceStt: () => sttService,
    resolveVoiceTts: () => ttsService,
    resolveDictationStt: () => dictationSttService,
    getSpeechReadiness: () => computeReadinessSnapshot(),
    cleanup,
    localModelConfig,
  };
}
