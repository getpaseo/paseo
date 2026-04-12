import { z } from "zod";

import type { MiniMaxTTSConfig, MiniMaxTTSVoice } from "./tts.js";

export const DEFAULT_MINIMAX_TTS_MODEL = "speech-2.8-hd";
export const DEFAULT_MINIMAX_TTS_VOICE: MiniMaxTTSVoice = "English_Graceful_Lady";

export type MiniMaxSpeechProviderConfig = {
  apiKey: string;
  tts?: Partial<MiniMaxTTSConfig>;
};

const MiniMaxTtsVoiceSchema = z.enum([
  "English_Graceful_Lady",
  "English_Insightful_Speaker",
  "English_radiant_girl",
  "English_Persuasive_Man",
  "English_Lucky_Robot",
  "English_expressive_narrator",
]);

const MiniMaxTtsModelSchema = z.enum(["speech-2.8-hd", "speech-2.8-turbo"]);

const OptionalTrimmedStringSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const MiniMaxSpeechResolutionSchema = z.object({
  apiKey: OptionalTrimmedStringSchema,
  ttsVoice: z.string().trim().pipe(MiniMaxTtsVoiceSchema).default(DEFAULT_MINIMAX_TTS_VOICE),
  ttsModel: z.string().trim().pipe(MiniMaxTtsModelSchema).default(DEFAULT_MINIMAX_TTS_MODEL),
  ttsBaseUrl: OptionalTrimmedStringSchema,
});

export function resolveMiniMaxSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
}): MiniMaxSpeechProviderConfig | undefined {
  const parsed = MiniMaxSpeechResolutionSchema.parse({
    apiKey: params.env.MINIMAX_API_KEY,
    ttsVoice: params.env.MINIMAX_TTS_VOICE ?? DEFAULT_MINIMAX_TTS_VOICE,
    ttsModel: params.env.MINIMAX_TTS_MODEL ?? DEFAULT_MINIMAX_TTS_MODEL,
    ttsBaseUrl: params.env.MINIMAX_BASE_URL,
  });

  if (!parsed.apiKey) {
    return undefined;
  }

  return {
    apiKey: parsed.apiKey,
    tts: {
      apiKey: parsed.apiKey,
      model: parsed.ttsModel,
      voice: parsed.ttsVoice,
      ...(parsed.ttsBaseUrl ? { baseUrl: parsed.ttsBaseUrl } : {}),
    },
  };
}
