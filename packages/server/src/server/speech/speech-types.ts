import { z } from "zod";

const NormalizedProviderIdSchema = z.string().trim().toLowerCase();

export const SttProviderIdSchema = NormalizedProviderIdSchema.pipe(
  z.enum(["openai", "local", "gemini"]),
);
export type SttProviderId = z.infer<typeof SttProviderIdSchema>;

export const TurnDetectionProviderIdSchema = NormalizedProviderIdSchema.pipe(
  z.enum(["openai", "local"]),
);
export type TurnDetectionProviderId = z.infer<typeof TurnDetectionProviderIdSchema>;

export const TtsProviderIdSchema = NormalizedProviderIdSchema.pipe(
  z.enum(["openai", "local", "gemini"]),
);
export type TtsProviderId = z.infer<typeof TtsProviderIdSchema>;

export type SpeechProviderId = SttProviderId | TurnDetectionProviderId | TtsProviderId;

export interface RequestedSpeechProvider<TProvider extends SpeechProviderId = SpeechProviderId> {
  provider: TProvider;
  explicit: boolean;
  enabled?: boolean;
}

export interface RequestedSpeechProviders {
  dictationStt: RequestedSpeechProvider<SttProviderId>;
  voiceTurnDetection: RequestedSpeechProvider<TurnDetectionProviderId>;
  voiceStt: RequestedSpeechProvider<SttProviderId>;
  voiceTts: RequestedSpeechProvider<TtsProviderId>;
}
