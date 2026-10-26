import { z } from "zod";

// Per-site settings mirror config.json. Unknown providers remain parseable by older
// clients; the feature UI decides whether it knows how to edit them.
const ModelFields = { model: z.string().optional() };
const OpenAiReadFields = {
  ...ModelFields,
  hasApiKey: z.boolean(),
  baseUrl: z.string().optional(),
};
const SttReadFields = {
  language: z.string().optional(),
  confidenceThreshold: z.number().optional(),
};
const LocalTtsFields = { speakerId: z.number().int().optional(), speed: z.number().optional() };

export const SpeechSttSettingsSchema = z.union([
  z
    .object({ provider: z.literal("local"), ...ModelFields, language: z.string().optional() })
    .passthrough(),
  z.object({ provider: z.literal("openai"), ...OpenAiReadFields, ...SttReadFields }).passthrough(),
  z.object({ provider: z.string(), ...ModelFields }).passthrough(),
]);
export const SpeechTtsSettingsSchema = z.union([
  z.object({ provider: z.literal("local"), ...ModelFields, ...LocalTtsFields }).passthrough(),
  z
    .object({ provider: z.literal("openai"), ...OpenAiReadFields, voice: z.string().optional() })
    .passthrough(),
  z.object({ provider: z.string(), ...ModelFields }).passthrough(),
]);

export const SpeechSettingsSchema = z
  .object({
    dictation: z.object({ enabled: z.boolean(), stt: SpeechSttSettingsSchema }).passthrough(),
    voiceMode: z
      .object({
        enabled: z.boolean(),
        stt: SpeechSttSettingsSchema,
        tts: SpeechTtsSettingsSchema,
        llm: z
          .object({ provider: z.string().optional(), model: z.string().optional() })
          .passthrough()
          .optional(),
        turnDetection: z.object({ provider: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const ModelPatchFields = { model: z.string().nullable().optional() };
const OpenAiPatchFields = {
  ...ModelPatchFields,
  apiKey: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
};
const SttPatchFields = {
  language: z.string().nullable().optional(),
  confidenceThreshold: z.number().nullable().optional(),
};
const LocalTtsPatchFields = {
  speakerId: z.number().int().nullable().optional(),
  speed: z.number().nullable().optional(),
};
const SpeechSttSettingsPatchSchema = z.union([
  z
    .object({
      provider: z.literal("local"),
      ...ModelPatchFields,
      language: z.string().nullable().optional(),
    })
    .passthrough(),
  z
    .object({ provider: z.literal("openai"), ...OpenAiPatchFields, ...SttPatchFields })
    .passthrough(),
  z.object({ provider: z.string().nullable() }).passthrough(),
  z
    .object({ provider: z.undefined().optional(), ...OpenAiPatchFields, ...SttPatchFields })
    .passthrough(),
]);
const SpeechTtsSettingsPatchSchema = z.union([
  z
    .object({ provider: z.literal("local"), ...ModelPatchFields, ...LocalTtsPatchFields })
    .passthrough(),
  z
    .object({
      provider: z.literal("openai"),
      ...OpenAiPatchFields,
      voice: z.string().nullable().optional(),
    })
    .passthrough(),
  z.object({ provider: z.string().nullable() }).passthrough(),
  z
    .object({
      provider: z.undefined().optional(),
      ...OpenAiPatchFields,
      ...LocalTtsPatchFields,
      voice: z.string().nullable().optional(),
    })
    .passthrough(),
]);
export const SpeechSettingsPatchSchema = z
  .object({
    dictation: z
      .object({
        enabled: z.boolean().nullable().optional(),
        stt: SpeechSttSettingsPatchSchema.optional(),
      })
      .passthrough()
      .optional(),
    voiceMode: z
      .object({
        enabled: z.boolean().nullable().optional(),
        stt: SpeechSttSettingsPatchSchema.optional(),
        tts: SpeechTtsSettingsPatchSchema.optional(),
        llm: z
          .object({
            provider: z.string().nullable().optional(),
            model: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
        turnDetection: z
          .object({ provider: z.string().nullable().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type SpeechSettings = z.infer<typeof SpeechSettingsSchema>;
export type SpeechSettingsPatch = z.infer<typeof SpeechSettingsPatchSchema>;

// ---------------------------------------------------------------------------
// Local speech models: catalog, install state, download, delete.
// ---------------------------------------------------------------------------

export const LocalSpeechModelSchema = z
  .object({
    id: z.string(),
    // "stt" or "tts".
    kind: z.string(),
    label: z.string(),
    description: z.string(),
    languages: z.array(z.string()),
    downloadSizeBytes: z.number(),
    isDefault: z.boolean(),
    // Selected by an enabled feature; the daemon keeps it installed.
    inUse: z.boolean(),
    // "installed" | "not_installed" | "downloading" | "extracting" | "failed".
    status: z.string(),
    receivedBytes: z.number().optional(),
    totalBytes: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type LocalSpeechModel = z.infer<typeof LocalSpeechModelSchema>;

export const SpeechLocalModelsListRequestSchema = z.object({
  type: z.literal("speech.local_models.list.request"),
  requestId: z.string(),
});

export const SpeechLocalModelsDownloadRequestSchema = z.object({
  type: z.literal("speech.local_models.download.request"),
  requestId: z.string(),
  modelId: z.string(),
});

export const SpeechLocalModelsDeleteRequestSchema = z.object({
  type: z.literal("speech.local_models.delete.request"),
  requestId: z.string(),
  modelId: z.string(),
});

export const SpeechLocalModelsListResponseSchema = z.object({
  type: z.literal("speech.local_models.list.response"),
  payload: z.object({
    requestId: z.string(),
    models: z.array(LocalSpeechModelSchema),
    error: z.string().nullable(),
  }),
});

// Resolves once the download starts; poll the list for progress.
export const SpeechLocalModelsDownloadResponseSchema = z.object({
  type: z.literal("speech.local_models.download.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const SpeechLocalModelsDeleteResponseSchema = z.object({
  type: z.literal("speech.local_models.delete.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});
