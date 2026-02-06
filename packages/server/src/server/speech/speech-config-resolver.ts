import path from "node:path";

import type { STTConfig } from "./providers/openai/stt.js";
import type { TTSConfig } from "./providers/openai/tts.js";
import type { PersistedConfig } from "../persisted-config.js";
import type { PaseoOpenAIConfig, PaseoSpeechConfig } from "../bootstrap.js";
import { LocalSttModelIdSchema, LocalTtsModelIdSchema } from "./providers/local/sherpa/model-catalog.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL,
  type SpeechProviderId,
} from "./speech-types.js";
const DEFAULT_LOCAL_MODELS_SUBDIR = path.join("models", "local-speech");
const DEFAULT_OPENAI_TTS_MODEL: TTSConfig["model"] = "tts-1";

function parseSpeechProviderId(value: unknown): SpeechProviderId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "openai") return "openai";
  if (normalized === "local") return "local";
  return null;
}

function parseBooleanFlag(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return null;
}

function parseNumberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOpenAiConfig(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig,
  providers: {
    dictationSttProvider: SpeechProviderId;
    voiceSttProvider: SpeechProviderId;
    voiceTtsProvider: SpeechProviderId;
  }
): PaseoOpenAIConfig | undefined {
  const apiKey = env.OPENAI_API_KEY ?? persisted.providers?.openai?.apiKey;
  if (!apiKey) return undefined;

  const sttConfidenceThreshold = parseNumberOrUndefined(env.STT_CONFIDENCE_THRESHOLD)
    ?? persisted.features?.dictation?.stt?.confidenceThreshold;

  const sttModel = (
    env.STT_MODEL
    ?? (providers.voiceSttProvider === "openai" ? persisted.features?.voiceMode?.stt?.model : undefined)
    ?? (providers.dictationSttProvider === "openai" ? persisted.features?.dictation?.stt?.model : undefined)
  ) as STTConfig["model"] | undefined;

  const ttsVoice = (
    env.TTS_VOICE
    || (providers.voiceTtsProvider === "openai" ? persisted.features?.voiceMode?.tts?.voice : undefined)
    || "alloy"
  ) as TTSConfig["voice"];
  const ttsModelRaw =
    env.TTS_MODEL
    || (providers.voiceTtsProvider === "openai" ? persisted.features?.voiceMode?.tts?.model : undefined)
    || DEFAULT_OPENAI_TTS_MODEL;
  const ttsModel: TTSConfig["model"] =
    ttsModelRaw === "tts-1" || ttsModelRaw === "tts-1-hd" ? ttsModelRaw : DEFAULT_OPENAI_TTS_MODEL;

  const realtimeTranscriptionModel =
    env.OPENAI_REALTIME_TRANSCRIPTION_MODEL
    || (providers.dictationSttProvider === "openai"
      ? persisted.features?.dictation?.stt?.model
      : undefined)
    || DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL;

  return {
    apiKey,
    stt: {
      apiKey,
      ...(sttConfidenceThreshold !== undefined ? { confidenceThreshold: sttConfidenceThreshold } : {}),
      ...(sttModel ? { model: sttModel } : {}),
    },
    tts: {
      apiKey,
      voice: ttsVoice,
      model: ttsModel,
      responseFormat: "pcm",
    },
    realtimeTranscriptionModel,
  };
}

export function resolveSpeechConfig(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): {
  openai: PaseoOpenAIConfig | undefined;
  speech: PaseoSpeechConfig;
} {
  const { paseoHome, env, persisted } = params;

  const dictationSttProvider =
    parseSpeechProviderId(env.PASEO_DICTATION_STT_PROVIDER)
    ?? parseSpeechProviderId(persisted.features?.dictation?.stt?.provider)
    ?? "local";

  const voiceSttProvider =
    parseSpeechProviderId(env.PASEO_VOICE_STT_PROVIDER)
    ?? parseSpeechProviderId(persisted.features?.voiceMode?.stt?.provider)
    ?? "local";

  const voiceTtsProvider =
    parseSpeechProviderId(env.PASEO_VOICE_TTS_PROVIDER)
    ?? parseSpeechProviderId(persisted.features?.voiceMode?.tts?.provider)
    ?? "local";

  const anyLocalRequested =
    dictationSttProvider === "local" ||
    voiceSttProvider === "local" ||
    voiceTtsProvider === "local" ||
    env.PASEO_LOCAL_MODELS_DIR !== undefined ||
    persisted.providers?.local !== undefined;

  const localModelsDir =
    env.PASEO_LOCAL_MODELS_DIR
    ?? persisted.providers?.local?.modelsDir
    ?? path.join(paseoHome, DEFAULT_LOCAL_MODELS_SUBDIR);

  const localAutoDownload =
    parseBooleanFlag(env.PASEO_LOCAL_AUTO_DOWNLOAD)
    ?? persisted.providers?.local?.autoDownload
    ?? true;

  const dictationLocalSttModel = LocalSttModelIdSchema.parse(
    env.PASEO_DICTATION_LOCAL_STT_MODEL
    ?? persisted.features?.dictation?.stt?.model
    ?? DEFAULT_LOCAL_STT_MODEL
  );

  const voiceLocalSttModel = LocalSttModelIdSchema.parse(
    env.PASEO_VOICE_LOCAL_STT_MODEL
    ?? persisted.features?.voiceMode?.stt?.model
    ?? DEFAULT_LOCAL_STT_MODEL
  );

  const voiceLocalTtsModel = LocalTtsModelIdSchema.parse(
    env.PASEO_VOICE_LOCAL_TTS_MODEL
    ?? persisted.features?.voiceMode?.tts?.model
    ?? DEFAULT_LOCAL_TTS_MODEL
  );

  const voiceLocalTtsSpeakerId =
    parseIntOrUndefined(env.PASEO_VOICE_LOCAL_TTS_SPEAKER_ID)
    ?? persisted.features?.voiceMode?.tts?.speakerId;

  const voiceLocalTtsSpeed =
    parseNumberOrUndefined(env.PASEO_VOICE_LOCAL_TTS_SPEED)
    ?? persisted.features?.voiceMode?.tts?.speed;

  return {
    openai: parseOpenAiConfig(env, persisted, {
      dictationSttProvider,
      voiceSttProvider,
      voiceTtsProvider,
    }),
    speech: {
      dictationSttProvider,
      voiceSttProvider,
      voiceTtsProvider,
      ...(anyLocalRequested
        ? {
            local: {
              modelsDir: localModelsDir.trim(),
              autoDownload: localAutoDownload,
            },
          }
        : {}),
      dictationLocalSttModel,
      voiceLocalSttModel,
      voiceLocalTtsModel,
      ...(voiceLocalTtsSpeakerId !== undefined ? { voiceLocalTtsSpeakerId } : {}),
      ...(voiceLocalTtsSpeed !== undefined ? { voiceLocalTtsSpeed } : {}),
    },
  };
}
