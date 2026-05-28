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
import {
  clearLocalSpeechRuntimeHome,
  configureLocalSpeechRuntimeHome,
  ensureLocalSpeechRuntime,
  getLocalSpeechRuntimeStatus,
  type LocalSpeechRuntimePackageId,
} from "./providers/local/runtime/index.js";
import { initializeLocalSpeechServices } from "./providers/local/runtime.js";
import {
  getOpenAiSpeechAvailability,
  initializeOpenAiSpeechServices,
  validateOpenAiCredentialRequirements,
} from "./providers/openai/runtime.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import type { RequestedSpeechProviders } from "./speech-types.js";
import type { TurnDetectionProvider } from "./turn-detection-provider.js";

const SPEECH_RUNTIME_MONITOR_INTERVAL_MS = 3000;

export type SpeechReadinessReasonCode =
  | "ready"
  | "disabled"
  | "runtime_install_in_progress"
  | "runtime_missing"
  | "runtime_install_failed"
  | "model_download_in_progress"
  | "models_missing"
  | "model_download_failed"
  | "turn_detection_unavailable"
  | "stt_unavailable"
  | "tts_unavailable";

export type SpeechInstallableAssetKind = "models" | "runtime";

export interface SpeechMissingAsset {
  kind: SpeechInstallableAssetKind;
  ids: string[];
}

export interface SpeechReadinessState {
  enabled: boolean;
  available: boolean;
  reasonCode: SpeechReadinessReasonCode;
  message: string;
  retryable: boolean;
  missingAssets: SpeechMissingAsset[];
}

export interface SpeechReadinessSnapshot {
  generatedAt: string;
  requiredLocalModelIds: LocalSpeechModelId[];
  missingLocalModelIds: LocalSpeechModelId[];
  assets: Record<
    SpeechInstallableAssetKind,
    {
      label: string;
      missingIds: string[];
      inProgress: boolean;
      error: string | null;
    }
  >;
  realtimeVoice: SpeechReadinessState;
  dictation: SpeechReadinessState;
  voiceFeature: SpeechReadinessState;
}

interface InstallableAsset<TMissingId extends string> {
  readonly kind: SpeechInstallableAssetKind;
  readonly label: string;
  readonly reasonCodes: {
    inProgress: SpeechReadinessReasonCode;
    failed: SpeechReadinessReasonCode;
    missing: SpeechReadinessReasonCode;
  };
  readonly messages: {
    inProgress(missingIds: TMissingId[]): string;
    failed(error: string): string;
    missing(missingIds: TMissingId[]): string;
  };
  getMissing(): Promise<TMissingId[]>;
  install(missingIds: TMissingId[]): Promise<void>;
}

interface InstallableAssetRuntimeState {
  label: string;
  missingIds: string[];
  inProgress: boolean;
  error: string | null;
}

function resolveRequestedSpeechProviders(
  speechConfig: PaseoSpeechConfig | null,
): RequestedSpeechProviders {
  const defaults: RequestedSpeechProviders = {
    dictationStt: { provider: "local", explicit: false, enabled: true },
    voiceTurnDetection: { provider: "local", explicit: false, enabled: true },
    voiceStt: { provider: "local", explicit: false, enabled: true },
    voiceTts: { provider: "local", explicit: false, enabled: true },
  };

  const fromConfig = speechConfig?.providers;
  if (!fromConfig) {
    return defaults;
  }

  return {
    dictationStt: fromConfig.dictationStt ?? defaults.dictationStt,
    voiceTurnDetection: fromConfig.voiceTurnDetection ?? defaults.voiceTurnDetection,
    voiceStt: fromConfig.voiceStt ?? defaults.voiceStt,
    voiceTts: fromConfig.voiceTts ?? defaults.voiceTts,
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

  const checks = await Promise.all(
    requiredModelIds.map(async (modelId) => {
      const spec = specsById.get(modelId);
      if (!spec) return { modelId, missing: true };
      const modelDir = getLocalSpeechModelDir(modelsDir, modelId);
      const filePresence = await Promise.all(
        spec.requiredFiles.map((relPath) => hasRequiredLocalModelFile(join(modelDir, relPath))),
      );
      return { modelId, missing: !filePresence.every((present) => present) };
    }),
  );
  for (const check of checks) {
    if (check.missing) missing.add(check.modelId);
  }

  return Array.from(missing);
}

function joinModelIds(modelIds: LocalSpeechModelId[]): string {
  if (modelIds.length === 0) {
    return "none";
  }
  return modelIds.join(", ");
}

function readinessState(params: {
  enabled: boolean;
  available: boolean;
  reasonCode: SpeechReadinessReasonCode;
  message: string;
  retryable: boolean;
  missingAssets?: SpeechMissingAsset[];
}): SpeechReadinessState {
  return {
    ...params,
    missingAssets: params.missingAssets ?? [],
  };
}

function buildRealtimeVoiceReadiness(params: {
  providers: RequestedSpeechProviders;
  turnDetectionService: TurnDetectionProvider | null;
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
}): SpeechReadinessState {
  const voiceTurnDetectionEnabled = params.providers.voiceTurnDetection.enabled !== false;
  const voiceSttEnabled = params.providers.voiceStt.enabled !== false;
  const voiceTtsEnabled = params.providers.voiceTts.enabled !== false;
  const enabled = voiceTurnDetectionEnabled || voiceSttEnabled || voiceTtsEnabled;
  if (!enabled) {
    return readinessState({
      enabled: false,
      available: false,
      reasonCode: "disabled",
      message: "Realtime voice is disabled in daemon config.",
      retryable: false,
    });
  }
  if (voiceTurnDetectionEnabled && !params.turnDetectionService) {
    return readinessState({
      enabled: true,
      available: false,
      reasonCode: "turn_detection_unavailable",
      message: "Realtime voice is unavailable: turn-detection service is not ready.",
      retryable: false,
    });
  }
  if (voiceSttEnabled && !params.sttService) {
    return readinessState({
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Realtime voice is unavailable: speech-to-text service is not ready.",
      retryable: false,
    });
  }
  if (voiceTtsEnabled && !params.ttsService) {
    return readinessState({
      enabled: true,
      available: false,
      reasonCode: "tts_unavailable",
      message: "Realtime voice is unavailable: text-to-speech service is not ready.",
      retryable: false,
    });
  }
  return readinessState({
    enabled: true,
    available: true,
    reasonCode: "ready",
    message: "Realtime voice is ready.",
    retryable: false,
  });
}

function buildDictationReadiness(params: {
  providers: RequestedSpeechProviders;
  dictationSttService: SpeechToTextProvider | null;
}): SpeechReadinessState {
  const enabled = params.providers.dictationStt.enabled !== false;
  if (!enabled) {
    return readinessState({
      enabled: false,
      available: false,
      reasonCode: "disabled",
      message: "Dictation is disabled in daemon config.",
      retryable: false,
    });
  }
  if (!params.dictationSttService) {
    return readinessState({
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Dictation is unavailable: speech-to-text service is not ready.",
      retryable: false,
    });
  }
  return readinessState({
    enabled: true,
    available: true,
    reasonCode: "ready",
    message: "Dictation is ready.",
    retryable: false,
  });
}

function buildVoiceFeatureReadiness(params: {
  realtimeVoice: SpeechReadinessState;
  dictation: SpeechReadinessState;
  registry: Array<InstallableAsset<string>>;
  assets: Record<SpeechInstallableAssetKind, InstallableAssetRuntimeState>;
}): SpeechReadinessState {
  const enabled = params.realtimeVoice.enabled || params.dictation.enabled;
  if (!enabled) {
    return readinessState({
      enabled: false,
      available: false,
      reasonCode: "disabled",
      message: "Voice features are disabled in daemon config.",
      retryable: false,
    });
  }

  for (const asset of params.registry) {
    const state = params.assets[asset.kind];
    if (state.missingIds.length === 0) {
      continue;
    }
    const missingAsset = { kind: asset.kind, ids: [...state.missingIds] };
    if (state.inProgress) {
      return readinessState({
        enabled: true,
        available: false,
        reasonCode: asset.reasonCodes.inProgress,
        message: asset.messages.inProgress(state.missingIds),
        retryable: true,
        missingAssets: [missingAsset],
      });
    }
    if (state.error) {
      return readinessState({
        enabled: true,
        available: false,
        reasonCode: asset.reasonCodes.failed,
        message: asset.messages.failed(state.error),
        retryable: false,
        missingAssets: [missingAsset],
      });
    }
    return readinessState({
      enabled: true,
      available: false,
      reasonCode: asset.reasonCodes.missing,
      message: asset.messages.missing(state.missingIds),
      retryable: true,
      missingAssets: [missingAsset],
    });
  }

  return readinessState({
    enabled: true,
    available: true,
    reasonCode: "ready",
    message: "Voice features are ready.",
    retryable: false,
  });
}

function describeRequestedProviders(providers: RequestedSpeechProviders): {
  dictationStt: { provider: string; enabled: boolean; explicit: boolean };
  voiceTurnDetection: { provider: string; enabled: boolean; explicit: boolean };
  voiceStt: { provider: string; enabled: boolean; explicit: boolean };
  voiceTts: { provider: string; enabled: boolean; explicit: boolean };
} {
  return {
    dictationStt: {
      provider: providers.dictationStt.provider,
      enabled: providers.dictationStt.enabled !== false,
      explicit: providers.dictationStt.explicit,
    },
    voiceTurnDetection: {
      provider: providers.voiceTurnDetection.provider,
      enabled: providers.voiceTurnDetection.enabled !== false,
      explicit: providers.voiceTurnDetection.explicit,
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

function requiresLocalSpeechRuntime(providers: RequestedSpeechProviders): boolean {
  return (
    (providers.dictationStt.enabled !== false && providers.dictationStt.provider === "local") ||
    (providers.voiceTurnDetection.enabled !== false &&
      providers.voiceTurnDetection.provider === "local") ||
    (providers.voiceStt.enabled !== false && providers.voiceStt.provider === "local") ||
    (providers.voiceTts.enabled !== false && providers.voiceTts.provider === "local")
  );
}

function resolveVoiceTtsLabel(
  ttsService: TextToSpeechProvider | null,
  localVoiceTtsProvider: TextToSpeechProvider | null,
): "unavailable" | "local" | "openai" {
  if (!ttsService) return "unavailable";
  if (ttsService === localVoiceTtsProvider) return "local";
  return "openai";
}

function resolveEffectiveProviderIds(params: {
  turnDetectionService: TurnDetectionProvider | null;
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
  localVoiceTtsProvider: TextToSpeechProvider | null;
}): {
  dictationStt: string;
  voiceTurnDetection: string;
  voiceStt: string;
  voiceTts: string;
} {
  return {
    dictationStt: params.dictationSttService?.id ?? "unavailable",
    voiceTurnDetection: params.turnDetectionService?.id ?? "unavailable",
    voiceStt: params.sttService?.id ?? "unavailable",
    voiceTts: resolveVoiceTtsLabel(params.ttsService, params.localVoiceTtsProvider),
  };
}

export interface SpeechService {
  resolveStt: () => SpeechToTextProvider | null;
  resolveSttLanguage: () => string;
  resolveTts: () => TextToSpeechProvider | null;
  resolveTurnDetection: () => TurnDetectionProvider | null;
  resolveDictationStt: () => SpeechToTextProvider | null;
  resolveDictationSttLanguage: () => string;
  getReadiness: () => SpeechReadinessSnapshot;
  onReadinessChange: (listener: (snapshot: SpeechReadinessSnapshot) => void) => () => void;
  start: () => void;
  stop: () => void;
  ready: Promise<void>;
}

export function createSpeechService(params: {
  logger: Logger;
  paseoHome: string;
  openaiConfig?: PaseoOpenAIConfig;
  speechConfig?: PaseoSpeechConfig;
}): SpeechService {
  const logger = params.logger.child({ module: "speech-runtime" });
  configureLocalSpeechRuntimeHome(params.paseoHome);
  const speechConfig = params.speechConfig ?? null;
  const openaiConfig = params.openaiConfig;
  const providers = resolveRequestedSpeechProviders(speechConfig);
  const requestedProviders = describeRequestedProviders(providers);
  const localRuntimeRequired = requiresLocalSpeechRuntime(providers);

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
    "Speech provider reconciliation started",
  );

  let sttService: SpeechToTextProvider | null = null;
  let ttsService: TextToSpeechProvider | null = null;
  let dictationSttService: SpeechToTextProvider | null = null;
  let turnDetectionService: TurnDetectionProvider | null = null;
  let localModelConfig: {
    modelsDir: string;
    defaultModelIds: LocalSpeechModelId[];
  } | null = null;
  let localCleanup = () => {};
  let localVoiceTtsProvider: TextToSpeechProvider | null = null;

  const assetStates: Record<SpeechInstallableAssetKind, InstallableAssetRuntimeState> = {
    models: {
      label: "models",
      missingIds: [],
      inProgress: false,
      error: null,
    },
    runtime: {
      label: "local voice runtime",
      missingIds: [],
      inProgress: false,
      error: null,
    },
  };
  let stopped = false;
  let monitorTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconcileInFlight: Promise<void> | null = null;
  const readinessListeners = new Set<(snapshot: SpeechReadinessSnapshot) => void>();
  let lastReadinessFingerprint: string | null = null;
  let lastPublishedReadinessSnapshot: SpeechReadinessSnapshot | null = null;
  let started = false;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const installableAssets: Array<InstallableAsset<string>> = [
    {
      kind: "runtime",
      label: "local voice runtime",
      reasonCodes: {
        inProgress: "runtime_install_in_progress",
        failed: "runtime_install_failed",
        missing: "runtime_missing",
      },
      messages: {
        inProgress: (missingIds) =>
          `Voice features are unavailable while the local voice runtime installs in the background (${missingIds.join(", ")}).`,
        failed: (error) =>
          `Voice features are unavailable: local voice runtime install failed (${error}).`,
        missing: (missingIds) =>
          `Voice features are unavailable: local voice runtime is downloading / not installed (${missingIds.join(", ")}).`,
      },
      getMissing: async (): Promise<LocalSpeechRuntimePackageId[]> => {
        if (!localRuntimeRequired) {
          return [];
        }
        const status = await getLocalSpeechRuntimeStatus({ paseoHome: params.paseoHome });
        return status.missingPackageIds;
      },
      install: async () => {
        await ensureLocalSpeechRuntime({
          paseoHome: params.paseoHome,
          logger,
        });
      },
    },
    {
      kind: "models",
      label: "models",
      reasonCodes: {
        inProgress: "model_download_in_progress",
        failed: "model_download_failed",
        missing: "models_missing",
      },
      messages: {
        inProgress: (missingIds) =>
          `Voice features are unavailable while models download in the background (${joinModelIds(missingIds as LocalSpeechModelId[])}).`,
        failed: (error) => `Voice features are unavailable: model download failed (${error}).`,
        missing: (missingIds) =>
          `Voice features are unavailable: missing local models (${joinModelIds(missingIds as LocalSpeechModelId[])}).`,
      },
      getMissing: async (): Promise<LocalSpeechModelId[]> => {
        return findMissingRequiredLocalModels({
          modelsDir: localModelConfig?.modelsDir ?? null,
          requiredModelIds: localModelConfig?.defaultModelIds ?? [],
        });
      },
      install: async (missingIds) => {
        const modelsDir = localModelConfig?.modelsDir ?? null;
        if (!modelsDir || missingIds.length === 0) {
          return;
        }
        await ensureLocalSpeechModels({
          modelsDir,
          modelIds: missingIds as LocalSpeechModelId[],
          logger,
        });
      },
    },
  ];

  const computeReadinessSnapshot = (): SpeechReadinessSnapshot => {
    const realtimeVoice = buildRealtimeVoiceReadiness({
      providers,
      turnDetectionService,
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
      registry: installableAssets,
      assets: assetStates,
    });
    return {
      generatedAt: new Date().toISOString(),
      requiredLocalModelIds: localModelConfig?.defaultModelIds ?? [],
      missingLocalModelIds: [...assetStates.models.missingIds] as LocalSpeechModelId[],
      assets: {
        models: {
          ...assetStates.models,
          missingIds: [...assetStates.models.missingIds],
        },
        runtime: {
          ...assetStates.runtime,
          missingIds: [...assetStates.runtime.missingIds],
        },
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

  const readinessFingerprint = (snapshot: SpeechReadinessSnapshot): string =>
    JSON.stringify({
      ...snapshot,
      generatedAt: "",
    });

  const publishReadinessIfChanged = (): void => {
    const snapshot = computeReadinessSnapshot();
    const fingerprint = readinessFingerprint(snapshot);
    if (fingerprint === lastReadinessFingerprint) {
      return;
    }
    lastReadinessFingerprint = fingerprint;
    lastPublishedReadinessSnapshot = snapshot;
    for (const listener of readinessListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        logger.warn({ err: error }, "Speech readiness listener threw an error");
      }
    }
  };

  const subscribeSpeechReadiness = (
    listener: (snapshot: SpeechReadinessSnapshot) => void,
  ): (() => void) => {
    readinessListeners.add(listener);
    const snapshot = lastPublishedReadinessSnapshot ?? computeReadinessSnapshot();
    if (!lastPublishedReadinessSnapshot) {
      lastPublishedReadinessSnapshot = snapshot;
      lastReadinessFingerprint = readinessFingerprint(snapshot);
    }
    try {
      listener(snapshot);
    } catch (error) {
      logger.warn({ err: error }, "Speech readiness listener threw an error during subscribe");
    }
    return () => {
      readinessListeners.delete(listener);
    };
  };

  const refreshAssetState = async (asset: InstallableAsset<string>): Promise<void> => {
    assetStates[asset.kind].missingIds = await asset.getMissing();
  };

  const refreshInstallableAssets = async (): Promise<void> => {
    await Promise.all(installableAssets.map(refreshAssetState));
  };

  const reconcileServices = async (): Promise<void> => {
    await refreshAssetState(installableAssets[0]);
    if (assetStates.runtime.missingIds.length > 0) {
      turnDetectionService = null;
      sttService = null;
      ttsService = null;
      dictationSttService = null;
      localVoiceTtsProvider = null;
      localModelConfig = null;
      localCleanup();
      localCleanup = () => {};
      return;
    }

    const nextLocalSpeech = await initializeLocalSpeechServices({
      providers,
      speechConfig,
      logger,
    });
    const nextOpenAiSpeech = initializeOpenAiSpeechServices({
      providers,
      openaiConfig,
      existing: {
        turnDetectionService: nextLocalSpeech.turnDetectionService,
        sttService: nextLocalSpeech.sttService,
        ttsService: nextLocalSpeech.ttsService,
        dictationSttService: nextLocalSpeech.dictationSttService,
      },
      logger,
    });

    const previousLocalCleanup = localCleanup;
    turnDetectionService = nextOpenAiSpeech.turnDetectionService;
    sttService = nextOpenAiSpeech.sttService;
    ttsService = nextOpenAiSpeech.ttsService;
    dictationSttService = nextOpenAiSpeech.dictationSttService;
    localModelConfig = nextLocalSpeech.localModelConfig;
    localVoiceTtsProvider = nextLocalSpeech.localVoiceTtsProvider;
    localCleanup = nextLocalSpeech.cleanup;
    previousLocalCleanup();

    await refreshAssetState(installableAssets[1]);

    const effectiveProviders = resolveEffectiveProviderIds({
      turnDetectionService,
      sttService,
      ttsService,
      dictationSttService,
      localVoiceTtsProvider,
    });
    const unavailableFeatures = [
      providers.dictationStt.enabled !== false && !dictationSttService ? "dictation.stt" : null,
      providers.voiceTurnDetection.enabled !== false && !turnDetectionService
        ? "voice.turnDetection"
        : null,
      providers.voiceStt.enabled !== false && !sttService ? "voice.stt" : null,
      providers.voiceTts.enabled !== false && !ttsService ? "voice.tts" : null,
    ].filter((feature): feature is string => feature !== null);

    if (unavailableFeatures.length > 0) {
      logger.warn(
        {
          requestedProviders,
          effectiveProviders,
          unavailableFeatures,
          missingLocalModelIds: assetStates.models.missingIds,
        },
        "Speech provider reconciliation completed with unavailable features",
      );
    } else {
      logger.info(
        {
          requestedProviders,
          effectiveProviders,
        },
        "Speech provider reconciliation completed",
      );
    }
  };

  const runReconcile = async (): Promise<void> => {
    if (reconcileInFlight) {
      await reconcileInFlight;
      publishReadinessIfChanged();
      return;
    }
    reconcileInFlight = reconcileServices().finally(() => {
      reconcileInFlight = null;
    });
    await reconcileInFlight;
    publishReadinessIfChanged();
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

  const startBackgroundInstall = (asset: InstallableAsset<string>): void => {
    const state = assetStates[asset.kind];
    if (stopped || state.inProgress || state.missingIds.length === 0) {
      return;
    }
    const missingIds = [...state.missingIds];
    state.inProgress = true;
    state.error = null;
    publishReadinessIfChanged();

    logger.info(
      {
        kind: asset.kind,
        missingIds,
      },
      "Starting background local speech asset install",
    );

    void (async () => {
      try {
        await asset.install(missingIds);
        await refreshAssetState(asset);
        state.error = null;
        await runReconcile();
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        publishReadinessIfChanged();
        logger.error(
          {
            err: error,
            kind: asset.kind,
            missingIds,
          },
          "Background local speech asset install failed",
        );
      } finally {
        state.inProgress = false;
        await refreshAssetState(asset).catch((error) => {
          logger.warn(
            { err: error, kind: asset.kind },
            "Failed to refresh local speech asset status after install",
          );
        });
        publishReadinessIfChanged();
        scheduleMonitor();
      }
    })();
  };

  const runMonitorTick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      await refreshInstallableAssets();
      const snapshot = computeReadinessSnapshot();
      if (
        snapshot.voiceFeature.enabled &&
        !snapshot.voiceFeature.available &&
        installableAssets.every((asset) => assetStates[asset.kind].missingIds.length === 0) &&
        installableAssets.every((asset) => !assetStates[asset.kind].inProgress)
      ) {
        await runReconcile();
      }

      for (const asset of installableAssets) {
        const state = assetStates[asset.kind];
        if (state.missingIds.length > 0 && !state.inProgress && !state.error) {
          startBackgroundInstall(asset);
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "Speech runtime monitor tick failed");
    } finally {
      publishReadinessIfChanged();
      scheduleMonitor();
    }
  };

  const start = (): void => {
    if (started || stopped) {
      return;
    }
    started = true;
    void (async () => {
      try {
        await runReconcile();
        const snapshot = computeReadinessSnapshot();
        if (snapshot.voiceFeature.enabled && !snapshot.voiceFeature.available) {
          for (const asset of installableAssets) {
            if (assetStates[asset.kind].missingIds.length > 0) {
              startBackgroundInstall(asset);
            }
          }
          scheduleMonitor();
        }
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        }
      } catch (error) {
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        logger.error({ err: error }, "Speech runtime failed during initial reconcile");
      }
    })();
  };

  const stop = (): void => {
    stopped = true;
    if (monitorTimeout) {
      clearTimeout(monitorTimeout);
      monitorTimeout = null;
    }
    localCleanup();
    clearLocalSpeechRuntimeHome();
  };

  return {
    resolveTurnDetection: () => turnDetectionService,
    resolveStt: () => sttService,
    resolveSttLanguage: () => speechConfig?.sttLanguages?.voice ?? "en",
    resolveTts: () => ttsService,
    resolveDictationStt: () => dictationSttService,
    resolveDictationSttLanguage: () => speechConfig?.sttLanguages?.dictation ?? "en",
    getReadiness: () => lastPublishedReadinessSnapshot ?? computeReadinessSnapshot(),
    onReadinessChange: subscribeSpeechReadiness,
    start,
    stop,
    ready,
  };
}
