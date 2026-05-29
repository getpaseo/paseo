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

function isLocalProviderEnabled(provider: { enabled?: boolean; provider: string }): boolean {
  return provider.enabled !== false && provider.provider === "local";
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

export async function initializeLocalSpeechServices(params: {
  providers: RequestedSpeechProviders;
  speechConfig: PaseoSpeechConfig | null;
  logger: Logger;
}): Promise<InitializedLocalSpeech> {
  const { providers, logger, speechConfig } = params;
  const localConfig = speechConfig?.local ?? null;
  const localModels = resolveConfiguredLocalModels(speechConfig);

  let sttService: SpeechToTextProvider | null = null;
  let ttsService: TextToSpeechProvider | null = null;
  let dictationSttService: SpeechToTextProvider | null = null;
  let turnDetectionService: TurnDetectionProvider | null = null;
  let localVoiceTtsProvider: TextToSpeechProvider | null = null;

  const requiredLocalModelIds = computeRequiredLocalModelIds({
    providers,
    models: localModels,
  });

  const workerClient = localConfig
    ? new LocalSpeechWorkerClient({
        config: {
          modelsDir: localConfig.modelsDir,
          voiceSttModel: localModels.voiceLocalSttModel,
          dictationSttModel: localModels.dictationLocalSttModel,
          voiceTtsModel: localModels.voiceLocalTtsModel,
          voiceTtsSpeakerId: speechConfig?.local?.models.voiceTtsSpeakerId,
          voiceTtsSpeed: speechConfig?.local?.models.voiceTtsSpeed,
        },
      })
    : null;

  if (isLocalProviderEnabled(providers.voiceTurnDetection)) {
    if (workerClient) {
      turnDetectionService = initializeLocalTurnDetection({ client: workerClient });
    } else {
      warnLocalConfigMissing(logger, "turn detection");
    }
  }

  if (isLocalProviderEnabled(providers.voiceStt)) {
    if (workerClient) {
      sttService = initializeLocalVoiceStt({ client: workerClient });
    } else {
      warnLocalConfigMissing(logger, "voice STT");
    }
  }

  if (isLocalProviderEnabled(providers.dictationStt)) {
    if (workerClient) {
      dictationSttService = initializeLocalDictationStt({ client: workerClient });
    } else {
      warnLocalConfigMissing(logger, "dictation STT");
    }
  }

  if (isLocalProviderEnabled(providers.voiceTts)) {
    if (workerClient) {
      localVoiceTtsProvider = initializeLocalVoiceTts({ client: workerClient });
    } else {
      warnLocalConfigMissing(logger, "voice TTS");
    }
    if (localVoiceTtsProvider) {
      ttsService = localVoiceTtsProvider;
    }
  }

  const cleanup = () => {
    workerClient?.shutdown();
  };

  return {
    turnDetectionService,
    sttService,
    ttsService,
    dictationSttService,
    localVoiceTtsProvider,
    localModelConfig: localConfig
      ? {
          modelsDir: localConfig.modelsDir,
          defaultModelIds: requiredLocalModelIds,
        }
      : null,
    availability: getLocalSpeechAvailability(speechConfig),
    cleanup,
  };
}
