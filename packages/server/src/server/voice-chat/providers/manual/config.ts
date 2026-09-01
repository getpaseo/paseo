import path from "node:path";
import { z } from "zod";
import type { AgentSessionConfig } from "../../../agent/agent-sdk-types.js";
import type { OpenAiSpeechProviderConfig } from "../../../speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "../../../speech/providers/local/config.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LocalSttModelIdSchema,
  LocalTtsModelIdSchema,
} from "../../../speech/providers/local/models.js";
import type { RequestedSpeechProviders } from "../../../speech/speech-types.js";

const SpeechProviderSchema = z.enum(["local", "openai"]);
const OpenAiVoiceSchema = z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
const OpenAiTtsModelSchema = z.enum(["tts-1", "tts-1-hd"]);

export const ManualVoicePersistedConfigSchema = z
  .object({
    orchestrator: z
      .object({
        provider: z.string().optional(),
        model: z.string().min(1).optional(),
        modeId: z.string().trim().min(1).optional(),
        thinkingOptionId: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    stt: z
      .object({
        provider: SpeechProviderSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    turnDetection: z.object({ provider: SpeechProviderSchema.optional() }).strict().optional(),
    tts: z
      .object({
        provider: SpeechProviderSchema.optional(),
        model: OpenAiTtsModelSchema.or(LocalTtsModelIdSchema).optional(),
        voice: OpenAiVoiceSchema.optional(),
        speakerId: z.number().int().optional(),
        speed: z.number().finite().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ManualVoicePersistedConfig = z.infer<typeof ManualVoicePersistedConfigSchema>;

export interface ManualVoiceOrchestratorConfig {
  provider: AgentSessionConfig["provider"];
  model?: string;
  modeId: string;
  thinkingOptionId?: string;
}

export interface ManualVoiceOrchestratorSettings {
  provider: AgentSessionConfig["provider"] | null;
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
}

export interface ManualVoiceConfig {
  orchestrator: ManualVoiceOrchestratorSettings;
  speech: {
    providers: RequestedSpeechProviders;
    sttLanguages: { dictation: string; voice: string };
    local?: LocalSpeechProviderConfig;
  };
  openai?: OpenAiSpeechProviderConfig;
}

interface ManualVoiceProviderCredentials {
  openai?: {
    apiKey?: string;
    baseUrl?: string;
    stt?: { apiKey?: string; baseUrl?: string };
    tts?: { apiKey?: string; baseUrl?: string };
  };
  local?: { modelsDir?: string };
}

interface ManualVoiceResolutionInput {
  paseoHome: string;
  persisted: ManualVoicePersistedConfig | undefined;
  providers: ManualVoiceProviderCredentials | undefined;
}

interface SelectedManualSpeechProviders {
  stt: z.infer<typeof SpeechProviderSchema>;
  turnDetection: z.infer<typeof SpeechProviderSchema>;
  tts: z.infer<typeof SpeechProviderSchema>;
}

function selectManualSpeechProviders(
  persisted: ManualVoicePersistedConfig | undefined,
): SelectedManualSpeechProviders {
  return {
    stt: persisted?.stt?.provider ?? "local",
    turnDetection: persisted?.turnDetection?.provider ?? "local",
    tts: persisted?.tts?.provider ?? "local",
  };
}

function resolveManualLocalConfig(
  input: ManualVoiceResolutionInput,
  selected: SelectedManualSpeechProviders,
): LocalSpeechProviderConfig | undefined {
  if (![selected.stt, selected.turnDetection, selected.tts].includes("local")) return undefined;

  const voiceStt = LocalSttModelIdSchema.parse(
    selected.stt === "local"
      ? (input.persisted?.stt?.model ?? DEFAULT_LOCAL_STT_MODEL)
      : DEFAULT_LOCAL_STT_MODEL,
  );
  const voiceTts = LocalTtsModelIdSchema.parse(
    selected.tts === "local"
      ? (input.persisted?.tts?.model ?? DEFAULT_LOCAL_TTS_MODEL)
      : DEFAULT_LOCAL_TTS_MODEL,
  );
  const models: LocalSpeechProviderConfig["models"] = {
    dictationStt: DEFAULT_LOCAL_STT_MODEL,
    voiceStt,
    voiceTts,
  };
  if (input.persisted?.tts?.speakerId !== undefined) {
    models.voiceTtsSpeakerId = input.persisted.tts.speakerId;
  } else if (voiceTts === "kokoro-en-v0_19") {
    models.voiceTtsSpeakerId = 0;
  }
  if (input.persisted?.tts?.speed !== undefined) {
    models.voiceTtsSpeed = input.persisted.tts.speed;
  }
  return {
    modelsDir:
      input.providers?.local?.modelsDir ?? path.join(input.paseoHome, "models", "local-speech"),
    models,
  };
}

function resolveManualOpenAiStt(
  input: ManualVoiceResolutionInput,
  provider: string,
): NonNullable<OpenAiSpeechProviderConfig["stt"]> | undefined {
  if (provider !== "openai") return undefined;
  const credentials = input.providers?.openai;
  const sttApiKey = credentials?.stt?.apiKey ?? credentials?.apiKey;
  if (!sttApiKey) return undefined;
  const config: NonNullable<OpenAiSpeechProviderConfig["stt"]> = { apiKey: sttApiKey };
  const baseUrl = credentials?.stt?.baseUrl ?? credentials?.baseUrl;
  if (baseUrl) config.baseUrl = baseUrl;
  if (input.persisted?.stt?.model) config.model = input.persisted.stt.model;
  return config;
}

function resolveManualOpenAiTts(
  input: ManualVoiceResolutionInput,
  provider: string,
): NonNullable<OpenAiSpeechProviderConfig["tts"]> | undefined {
  if (provider !== "openai") return undefined;
  const credentials = input.providers?.openai;
  const apiKey = credentials?.tts?.apiKey ?? credentials?.apiKey;
  if (!apiKey) return undefined;
  const config: NonNullable<OpenAiSpeechProviderConfig["tts"]> = {
    apiKey,
    model: OpenAiTtsModelSchema.parse(input.persisted?.tts?.model ?? "tts-1"),
    voice: input.persisted?.tts?.voice ?? "alloy",
    responseFormat: "pcm",
  };
  const baseUrl = credentials?.tts?.baseUrl ?? credentials?.baseUrl;
  if (baseUrl) config.baseUrl = baseUrl;
  return config;
}

function resolveManualOpenAiConfig(
  input: ManualVoiceResolutionInput,
  selected: SelectedManualSpeechProviders,
): OpenAiSpeechProviderConfig | undefined {
  const stt = resolveManualOpenAiStt(input, selected.stt);
  const tts = resolveManualOpenAiTts(input, selected.tts);
  if (!stt && !tts) return undefined;
  return { stt, tts };
}

function resolveManualSpeechConfig(
  input: ManualVoiceResolutionInput,
  selected: SelectedManualSpeechProviders,
  local: LocalSpeechProviderConfig | undefined,
): ManualVoiceConfig["speech"] {
  const persisted = input.persisted;
  const speech: ManualVoiceConfig["speech"] = {
    providers: {
      dictationStt: { provider: "local", explicit: false, enabled: false },
      voiceTurnDetection: {
        provider: selected.turnDetection,
        explicit: persisted?.turnDetection?.provider !== undefined,
      },
      voiceStt: {
        provider: selected.stt,
        explicit: persisted?.stt?.provider !== undefined,
      },
      voiceTts: {
        provider: selected.tts,
        explicit: persisted?.tts?.provider !== undefined,
      },
    },
    sttLanguages: { dictation: "en", voice: persisted?.stt?.language ?? "en" },
  };
  if (local) speech.local = local;
  return speech;
}

function resolveManualOrchestrator(
  persisted: ManualVoicePersistedConfig | undefined,
): ManualVoiceOrchestratorSettings {
  return {
    provider: persisted?.orchestrator?.provider ?? null,
    model: persisted?.orchestrator?.model ?? null,
    modeId: persisted?.orchestrator?.modeId ?? null,
    thinkingOptionId: persisted?.orchestrator?.thinkingOptionId ?? null,
  };
}

export function resolveManualVoiceConfig(input: {
  paseoHome: string;
  persisted: ManualVoicePersistedConfig | undefined;
  providers: ManualVoiceProviderCredentials | undefined;
}): ManualVoiceConfig {
  const selected = selectManualSpeechProviders(input.persisted);
  const local = resolveManualLocalConfig(input, selected);
  const openai = resolveManualOpenAiConfig(input, selected);
  const config: ManualVoiceConfig = {
    orchestrator: resolveManualOrchestrator(input.persisted),
    speech: resolveManualSpeechConfig(input, selected, local),
  };
  if (openai) config.openai = openai;
  return config;
}

export function resolveManualVoiceOrchestratorConfig(
  settings: ManualVoiceOrchestratorSettings,
): ManualVoiceOrchestratorConfig | null {
  if (!settings.provider || !settings.modeId) return null;
  return {
    provider: settings.provider,
    modeId: settings.modeId,
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
  };
}
