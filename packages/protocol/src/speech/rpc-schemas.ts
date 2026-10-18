import { z } from "zod";

// ---------------------------------------------------------------------------
// Speech settings: the `speech` section of the mutable daemon config.
// ---------------------------------------------------------------------------

// Provider ids stay plain strings so an old client can parse a daemon that adds one.
const SpeechSttSettingsSchema = z
  .object({
    provider: z.string(),
    // Omitted means the provider's default model.
    model: z.string().optional(),
    language: z.string().optional(),
  })
  .passthrough();

const SpeechTtsSettingsSchema = z
  .object({
    provider: z.string(),
    model: z.string().optional(),
    voice: z.string().optional(),
  })
  .passthrough();

export const SpeechSettingsSchema = z
  .object({
    dictation: z
      .object({
        enabled: z.boolean(),
        stt: SpeechSttSettingsSchema,
      })
      .passthrough(),
    voiceMode: z
      .object({
        enabled: z.boolean(),
        stt: SpeechSttSettingsSchema,
        tts: SpeechTtsSettingsSchema,
      })
      .passthrough(),
    openai: z
      .object({
        // The key itself is write-only; readers only learn whether one is set.
        apiKeyConfigured: z.boolean(),
        baseUrl: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

// null clears a field back to its default. Changing `provider` without `model` clears
// the model, because model ids belong to one provider.
const SpeechSttSettingsPatchSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
  })
  .passthrough();

const SpeechTtsSettingsPatchSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().nullable().optional(),
    voice: z.string().nullable().optional(),
  })
  .passthrough();

export const SpeechSettingsPatchSchema = z
  .object({
    dictation: z
      .object({
        enabled: z.boolean().optional(),
        stt: SpeechSttSettingsPatchSchema.optional(),
      })
      .passthrough()
      .optional(),
    voiceMode: z
      .object({
        enabled: z.boolean().optional(),
        stt: SpeechSttSettingsPatchSchema.optional(),
        tts: SpeechTtsSettingsPatchSchema.optional(),
      })
      .passthrough()
      .optional(),
    openai: z
      .object({
        apiKey: z.string().nullable().optional(),
        baseUrl: z.string().nullable().optional(),
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
