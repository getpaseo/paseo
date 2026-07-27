import type { Logger } from "pino";

import type { PaseoSpeechConfig } from "../../../bootstrap.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { TurnDetectionProvider } from "../../turn-detection-provider.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LocalSttModelIdSchema,
  LocalTtsModelIdSchema,
  type LocalSpeechModelId,
  type LocalSttModelId,
  type LocalTtsModelId,
} from "./models.js";
import {
  LocalSpeechWorkerClient,
  WorkerBackedSpeechToTextProvider,
  WorkerBackedTextToSpeechProvider,
  WorkerBackedTurnDetectionProvider,
} from "./worker-client.js";

interface ResolvedLocalModels {
  dictationLocalSttModel: LocalSttModelId;
  voiceLocalSttModel: LocalSttModelId;
  voiceLocalTtsModel: LocalTtsModelId;
}

interface LocalSpeechAvailability {
  configured: boolean;
  modelsDir: string | null;
}

export interface InitializedLocalSpeech {
  turnDetectionService: TurnDetectionProvider | null;
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
}

function resolveConfiguredLocalModels(speechConfig: PaseoSpeechConfig | null): ResolvedLocalModels {
  return {
    dictationLocalSttModel: LocalSttModelIdSchema.parse(
      speechConfig?.local?.models.dictationStt ?? DEFAULT_LOCAL_STT_MODEL,
    ),
    voiceLocalSttModel: LocalSttModelIdSchema.parse(
      speechConfig?.local?.models.voiceStt ?? DEFAULT_LOCAL_STT_MODEL,
    ),
    voiceLocalTtsModel: LocalTtsModelIdSchema.parse(
      speechConfig?.local?.models.voiceTts ?? DEFAULT_LOCAL_TTS_MODEL,
    ),
  };
}

export function getLocalSpeechAvailability(
  speechConfig: PaseoSpeechConfig | null,
): LocalSpeechAvailability {
  const localConfig = speechConfig?.local ?? null;
  return {
    configured: Boolean(localConfig),
    modelsDir: localConfig?.modelsDir ?? null,
  };
}

function computeRequiredLocalModelIds(params: {
  providers: RequestedSpeechProviders;
  models: ResolvedLocalModels;
}): LocalSpeechModelId[] {
  const ids = new Set<LocalSpeechModelId>();
  if (
    params.providers.dictationStt.enabled === true &&
    params.providers.dictationStt.provider === "local"
  ) {
    ids.add(params.models.dictationLocalSttModel);
  }
  if (
    params.providers.voiceStt.enabled === true &&
    params.providers.voiceStt.provider === "local"
  ) {
    ids.add(params.models.voiceLocalSttModel);
  }
  if (
    params.providers.voiceTts.enabled === true &&
    params.providers.voiceTts.provider === "local"
  ) {
    ids.add(params.models.voiceLocalTtsModel);
  }
  return Array.from(ids);
}

function isLocalProviderEnabled(provider: { enabled?: boolean; provider: string }): boolean {
  return provider.enabled === true && provider.provider === "local";
}

function warnLocalConfigMissing(logger: Logger, feature: string): void {
  logger.warn(
    { configured: false },
    `Local ${feature} selected but local provider config is missing; ${feature} will be unavailable`,
  );
}

function initializeLocalTurnDetection(params: {
  client: LocalSpeechWorkerClient;
}): TurnDetectionProvider {
  const { client } = params;
  return new WorkerBackedTurnDetectionProvider(client);
}

function initializeLocalVoiceStt(params: {
  client: LocalSpeechWorkerClient;
}): SpeechToTextProvider {
  const { client } = params;
  return new WorkerBackedSpeechToTextProvider(client, "voiceStt");
}

function initializeLocalDictationStt(params: {
  client: LocalSpeechWorkerClient;
}): SpeechToTextProvider {
  const { client } = params;
  return new WorkerBackedSpeechToTextProvider(client, "dictationStt");
}

function initializeLocalVoiceTts(params: {
  client: LocalSpeechWorkerClient;
}): TextToSpeechProvider {
  const { client } = params;
  return new WorkerBackedTextToSpeechProvider(client);
}

function isAnyLocalProviderEnabled(providers: RequestedSpeechProviders): boolean {
  return (
    isLocalProviderEnabled(providers.voiceTurnDetection) ||
    isLocalProviderEnabled(providers.voiceStt) ||
    isLocalProviderEnabled(providers.dictationStt) ||
    isLocalProviderEnabled(providers.voiceTts)
  );
}

function createLocalSpeechWorkerClient(params: {
  logger: Logger;
  localConfig: NonNullable<PaseoSpeechConfig["local"]>;
  localModels: ReturnType<typeof resolveConfiguredLocalModels>;
  speechConfig: PaseoSpeechConfig | null;
}): LocalSpeechWorkerClient {
  return new LocalSpeechWorkerClient({
    logger: params.logger,
    config: {
      modelsDir: params.localConfig.modelsDir,
      voiceSttModel: params.localModels.voiceLocalSttModel,
      dictationSttModel: params.localModels.dictationLocalSttModel,
      voiceTtsModel: params.localModels.voiceLocalTtsModel,
      voiceTtsSpeakerId: params.speechConfig?.local?.models.voiceTtsSpeakerId,
      voiceTtsSpeed: params.speechConfig?.local?.models.voiceTtsSpeed,
    },
  });
}

function resolveLocalProviderService<T>(params: {
  enabled: boolean;
  workerClient: LocalSpeechWorkerClient | null;
  logger: Logger;
  feature: string;
  create: (client: LocalSpeechWorkerClient) => T;
}): T | null {
  if (!params.enabled) {
    return null;
  }
  if (!params.workerClient) {
    warnLocalConfigMissing(params.logger, params.feature);
    return null;
  }
  return params.create(params.workerClient);
}

function initializeEnabledLocalProviders(params: {
  providers: RequestedSpeechProviders;
  workerClient: LocalSpeechWorkerClient | null;
  logger: Logger;
}): {
  turnDetectionService: TurnDetectionProvider | null;
  sttService: SpeechToTextProvider | null;
  dictationSttService: SpeechToTextProvider | null;
  localVoiceTtsProvider: TextToSpeechProvider | null;
  ttsService: TextToSpeechProvider | null;
} {
  const turnDetectionService = resolveLocalProviderService({
    enabled: isLocalProviderEnabled(params.providers.voiceTurnDetection),
    workerClient: params.workerClient,
    logger: params.logger,
    feature: "turn detection",
    create: (client) => initializeLocalTurnDetection({ client }),
  });
  const sttService = resolveLocalProviderService({
    enabled: isLocalProviderEnabled(params.providers.voiceStt),
    workerClient: params.workerClient,
    logger: params.logger,
    feature: "voice STT",
    create: (client) => initializeLocalVoiceStt({ client }),
  });
  const dictationSttService = resolveLocalProviderService({
    enabled: isLocalProviderEnabled(params.providers.dictationStt),
    workerClient: params.workerClient,
    logger: params.logger,
    feature: "dictation STT",
    create: (client) => initializeLocalDictationStt({ client }),
  });
  const localVoiceTtsProvider = resolveLocalProviderService({
    enabled: isLocalProviderEnabled(params.providers.voiceTts),
    workerClient: params.workerClient,
    logger: params.logger,
    feature: "voice TTS",
    create: (client) => initializeLocalVoiceTts({ client }),
  });
  return {
    turnDetectionService,
    sttService,
    dictationSttService,
    localVoiceTtsProvider,
    ttsService: localVoiceTtsProvider,
  };
}

export async function initializeLocalSpeechServices(params: {
  providers: RequestedSpeechProviders;
  speechConfig: PaseoSpeechConfig | null;
  logger: Logger;
}): Promise<InitializedLocalSpeech> {
  const { providers, logger, speechConfig } = params;
  const localConfig = speechConfig?.local ?? null;
  const localModels = resolveConfiguredLocalModels(speechConfig);
  const requiredLocalModelIds = computeRequiredLocalModelIds({
    providers,
    models: localModels,
  });
  const workerClient =
    localConfig && isAnyLocalProviderEnabled(providers)
      ? createLocalSpeechWorkerClient({
          logger,
          localConfig,
          localModels,
          speechConfig,
        })
      : null;
  const services = initializeEnabledLocalProviders({
    providers,
    workerClient,
    logger,
  });

  return {
    ...services,
    localModelConfig: localConfig
      ? {
          modelsDir: localConfig.modelsDir,
          defaultModelIds: requiredLocalModelIds,
        }
      : null,
    availability: getLocalSpeechAvailability(speechConfig),
    cleanup: () => {
      workerClient?.shutdown();
    },
  };
}
