import { z } from "zod";

export const SpeechProviderIdSchema = z.enum(["openai", "local"]);
export type SpeechProviderId = z.infer<typeof SpeechProviderIdSchema>;

export const RequestedSpeechProviderSchema = z.object({
  provider: SpeechProviderIdSchema,
  explicit: z.boolean(),
});
export type RequestedSpeechProvider = z.infer<typeof RequestedSpeechProviderSchema>;

export type RequestedSpeechProviders = {
  dictationStt: RequestedSpeechProvider;
  voiceStt: RequestedSpeechProvider;
  voiceTts: RequestedSpeechProvider;
};
