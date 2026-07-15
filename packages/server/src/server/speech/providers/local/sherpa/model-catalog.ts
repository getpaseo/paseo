import { z } from "zod";

export type SherpaOnnxModelKind = "stt-offline" | "tts";

export type SttModelType = "nemo_transducer" | "sense_voice" | "paraformer";

type DefaultModelRole = "stt" | "tts";

interface SherpaOnnxCatalogEntryBase {
  archiveUrl: string;
  extractedDir: string;
  requiredFiles: string[];
  description: string;
  defaultFor?: DefaultModelRole;
  /** Which language(s) this model is the default for (explicit priority over insertion order). */
  defaultForLanguages?: string[];
  supportedLanguages?: string[];
}

interface SherpaOnnxSttCatalogEntry extends SherpaOnnxCatalogEntryBase {
  kind: "stt-offline";
  sttModelType: SttModelType;
}

interface SherpaOnnxTtsCatalogEntry extends SherpaOnnxCatalogEntryBase {
  kind: "tts";
  /** Default speaker ID for TTS models (avoids scattering model-specific policy in config). */
  defaultSpeakerId?: number;
}

type SherpaOnnxCatalogEntry = SherpaOnnxSttCatalogEntry | SherpaOnnxTtsCatalogEntry;

export const SHERPA_ONNX_MODEL_CATALOG = {
  "parakeet-tdt-0.6b-v2-int8": {
    kind: "stt-offline",
    sttModelType: "nemo_transducer",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    description: "NVIDIA Parakeet TDT v2 (offline NeMo transducer, English).",
    defaultFor: "stt",
    supportedLanguages: ["en"],
  },
  "parakeet-tdt-0.6b-v3-int8": {
    kind: "stt-offline",
    sttModelType: "nemo_transducer",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    description:
      "NVIDIA Parakeet TDT v3 (offline NeMo transducer, 25 European languages, auto-detected).",
    supportedLanguages: [
      "en",
      "de",
      "fr",
      "es",
      "it",
      "pt",
      "nl",
      "pl",
      "ru",
      "uk",
      "cs",
      "sk",
      "ro",
      "hu",
      "bg",
      "hr",
      "sr",
      "sl",
      "lt",
      "lv",
      "et",
      "fi",
      "sv",
      "da",
      "no",
    ],
  },
  "sense-voice-zh-en-ja-ko-yue-int8": {
    kind: "stt-offline",
    sttModelType: "sense_voice",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    extractedDir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    requiredFiles: ["model.int8.onnx", "tokens.txt"],
    description: "SenseVoice (offline, Chinese/English/Japanese/Korean/Cantonese, auto-detected).",
    defaultForLanguages: ["zh", "ja", "ko", "yue"],
    supportedLanguages: ["zh", "en", "ja", "ko", "yue"],
  },
  "paraformer-zh-2024-03-09-int8": {
    kind: "stt-offline",
    sttModelType: "paraformer",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2024-03-09.tar.bz2",
    extractedDir: "sherpa-onnx-paraformer-zh-2024-03-09",
    requiredFiles: ["model.int8.onnx", "tokens.txt"],
    description: "Paraformer Chinese+English (offline, higher accuracy for Mandarin and dialects).",
    supportedLanguages: ["zh", "en"],
  },
  "kokoro-en-v0_19": {
    kind: "tts",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2",
    extractedDir: "kokoro-en-v0_19",
    requiredFiles: ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    description: "Kokoro TTS (higher quality; larger).",
    defaultFor: "tts",
    defaultSpeakerId: 0,
    supportedLanguages: ["en"],
  },
  "kokoro-multi-lang-v1_0": {
    kind: "tts",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
    extractedDir: "kokoro-multi-lang-v1_0",
    requiredFiles: [
      "model.onnx",
      "voices.bin",
      "tokens.txt",
      "espeak-ng-data",
      "lexicon-us-en.txt",
      "lexicon-zh.txt",
    ],
    description: "Kokoro TTS (multilingual Chinese + English).",
    defaultForLanguages: ["zh"],
    /** Speaker 48 = Chinese female voice (Zhihua). */
    defaultSpeakerId: 48,
    supportedLanguages: ["zh", "en"],
  },
} as const satisfies Record<string, SherpaOnnxCatalogEntry>;

export type SherpaOnnxModelId = keyof typeof SHERPA_ONNX_MODEL_CATALOG;
export type LocalSpeechModelId = SherpaOnnxModelId;

type ModelIdByKind<K extends SherpaOnnxModelKind> = {
  [Id in SherpaOnnxModelId]: (typeof SHERPA_ONNX_MODEL_CATALOG)[Id]["kind"] extends K ? Id : never;
}[SherpaOnnxModelId];

export type LocalSttModelId = ModelIdByKind<"stt-offline">;
export type LocalTtsModelId = ModelIdByKind<"tts">;

const ALL_MODEL_IDS: SherpaOnnxModelId[] = Object.keys(SHERPA_ONNX_MODEL_CATALOG).filter(
  (k): k is SherpaOnnxModelId => k in SHERPA_ONNX_MODEL_CATALOG,
);

function isLocalSttModelId(id: SherpaOnnxModelId): id is LocalSttModelId {
  return SHERPA_ONNX_MODEL_CATALOG[id].kind !== "tts";
}

function isLocalTtsModelId(id: SherpaOnnxModelId): id is LocalTtsModelId {
  return SHERPA_ONNX_MODEL_CATALOG[id].kind === "tts";
}

export const LOCAL_STT_MODEL_IDS: LocalSttModelId[] = ALL_MODEL_IDS.filter(isLocalSttModelId);

export const LOCAL_TTS_MODEL_IDS: LocalTtsModelId[] = ALL_MODEL_IDS.filter(isLocalTtsModelId);

function resolveDefaultModelId(role: "stt"): LocalSttModelId;
function resolveDefaultModelId(role: "tts"): LocalTtsModelId;
function resolveDefaultModelId(role: DefaultModelRole): SherpaOnnxModelId {
  const match = ALL_MODEL_IDS.find((id) => {
    const entry: SherpaOnnxCatalogEntry = SHERPA_ONNX_MODEL_CATALOG[id];
    return entry.defaultFor === role;
  });
  if (!match) {
    throw new Error(`No default model configured for role '${role}'`);
  }
  return match;
}

export const DEFAULT_LOCAL_STT_MODEL = resolveDefaultModelId("stt");
export const DEFAULT_LOCAL_TTS_MODEL = resolveDefaultModelId("tts");

function createModelIdSchema<T extends string>(modelIds: readonly T[]): z.ZodType<T, string> {
  const validIds = new Set<string>(modelIds);
  return z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => validIds.has(value), {
      message: "Invalid model id",
    })
    .transform((value) => value as T);
}

export const LocalSttModelIdSchema = createModelIdSchema(LOCAL_STT_MODEL_IDS);
export const LocalTtsModelIdSchema = createModelIdSchema(LOCAL_TTS_MODEL_IDS);

export type SherpaOnnxSttModelSpec = SherpaOnnxSttCatalogEntry & {
  id: LocalSttModelId;
};

export type SherpaOnnxTtsModelSpec = SherpaOnnxTtsCatalogEntry & {
  id: LocalTtsModelId;
};

export type SherpaOnnxModelSpec = SherpaOnnxSttModelSpec | SherpaOnnxTtsModelSpec;

export function listSherpaOnnxModels(): SherpaOnnxModelSpec[] {
  return ALL_MODEL_IDS.map((id) =>
    Object.assign({ id }, SHERPA_ONNX_MODEL_CATALOG[id]),
  ) as SherpaOnnxModelSpec[];
}

export function getSherpaOnnxModelSpec(id: LocalSttModelId): SherpaOnnxSttModelSpec;
export function getSherpaOnnxModelSpec(id: LocalTtsModelId): SherpaOnnxTtsModelSpec;
export function getSherpaOnnxModelSpec(id: SherpaOnnxModelId): SherpaOnnxModelSpec;
export function getSherpaOnnxModelSpec(id: SherpaOnnxModelId): SherpaOnnxModelSpec {
  const spec = SHERPA_ONNX_MODEL_CATALOG[id];
  if (!spec) {
    throw new Error(`Unknown local speech model id: ${id}`);
  }
  return {
    id,
    ...spec,
  } as SherpaOnnxModelSpec;
}

/** Returns the catalog-defined default speaker ID for a TTS model, or undefined if none. */
export function getDefaultSpeakerId(id: LocalTtsModelId): number | undefined {
  const entry = SHERPA_ONNX_MODEL_CATALOG[id];
  return entry.kind === "tts" ? entry.defaultSpeakerId : undefined;
}

/**
 * Normalize a BCP 47 language tag to its base subtag for catalog matching.
 * Examples: "zh-CN" -> "zh", "pt-BR" -> "pt", "en-US" -> "en", "EN" -> "en".
 */
function normalizeLanguageTag(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}

export function resolveDefaultSttModelForLanguage(language: string): LocalSttModelId {
  const lang = normalizeLanguageTag(language);
  // If the global default model supports this language, keep it.
  const defaultSpec = SHERPA_ONNX_MODEL_CATALOG[DEFAULT_LOCAL_STT_MODEL];
  if ((defaultSpec.supportedLanguages as readonly string[] | undefined)?.includes(lang)) {
    return DEFAULT_LOCAL_STT_MODEL;
  }
  // Prefer a model that explicitly declares itself as the default for this language.
  const explicit = LOCAL_STT_MODEL_IDS.find((id) => {
    const entry: SherpaOnnxCatalogEntry = SHERPA_ONNX_MODEL_CATALOG[id];
    return (entry.defaultForLanguages as readonly string[] | undefined)?.includes(lang);
  });
  if (explicit) return explicit;
  // Fallback: first model that supports the language.
  const match = LOCAL_STT_MODEL_IDS.find((id) => {
    const entry = SHERPA_ONNX_MODEL_CATALOG[id];
    return (entry.supportedLanguages as readonly string[] | undefined)?.includes(lang);
  });
  return match ?? DEFAULT_LOCAL_STT_MODEL;
}

export function resolveDefaultTtsModelForLanguage(language: string): LocalTtsModelId {
  const lang = normalizeLanguageTag(language);
  // If the global default model supports this language, keep it.
  const defaultSpec = SHERPA_ONNX_MODEL_CATALOG[DEFAULT_LOCAL_TTS_MODEL];
  if ((defaultSpec.supportedLanguages as readonly string[] | undefined)?.includes(lang)) {
    return DEFAULT_LOCAL_TTS_MODEL;
  }
  // Prefer a model that explicitly declares itself as the default for this language.
  const explicit = LOCAL_TTS_MODEL_IDS.find((id) => {
    const entry: SherpaOnnxCatalogEntry = SHERPA_ONNX_MODEL_CATALOG[id];
    return (entry.defaultForLanguages as readonly string[] | undefined)?.includes(lang);
  });
  if (explicit) return explicit;
  // Fallback: first model that supports the language.
  const match = LOCAL_TTS_MODEL_IDS.find((id) => {
    const entry = SHERPA_ONNX_MODEL_CATALOG[id];
    return (entry.supportedLanguages as readonly string[] | undefined)?.includes(lang);
  });
  return match ?? DEFAULT_LOCAL_TTS_MODEL;
}
