import { z } from "zod";

export type SherpaOnnxModelKind = "stt-online" | "stt-offline" | "tts";

type DefaultModelRole = "stt" | "tts";

type SherpaOnnxCatalogEntry = {
  kind: SherpaOnnxModelKind;
  archiveUrl?: string;
  downloadFiles?: Array<{ url: string; relPath: string }>;
  extractedDir: string;
  requiredFiles: string[];
  description: string;
  aliases?: readonly string[];
  defaultFor?: DefaultModelRole;
};

export const SHERPA_ONNX_MODEL_CATALOG = {
  "zipformer-bilingual-zh-en-2023-02-20": {
    kind: "stt-online",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2",
    extractedDir: "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    requiredFiles: [
      "encoder-epoch-99-avg-1.onnx",
      "decoder-epoch-99-avg-1.onnx",
      "joiner-epoch-99-avg-1.onnx",
      "tokens.txt",
    ],
    description: "Streaming Zipformer transducer (fast, good accuracy).",
    aliases: ["zipformer", "zipformer-bilingual"],
  },
  "paraformer-bilingual-zh-en": {
    kind: "stt-online",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
    extractedDir: "sherpa-onnx-streaming-paraformer-bilingual-zh-en",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
    description: "Streaming Paraformer (often strong accuracy; heavier).",
    aliases: ["paraformer"],
  },
  "parakeet-tdt-0.6b-v2-int8": {
    kind: "stt-offline",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    description: "NVIDIA Parakeet TDT v2 (offline NeMo transducer, English).",
    aliases: ["parakeet-v2", "parakeet-tdt-v2"],
    defaultFor: "stt",
  },
  "parakeet-tdt-0.6b-v3-int8": {
    kind: "stt-offline",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    description: "NVIDIA Parakeet TDT v3 (offline NeMo transducer, multilingual).",
    aliases: ["parakeet", "parakeet-v3", "parakeet-tdt"],
  },
  "kitten-nano-en-v0_1-fp16": {
    kind: "tts",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_1-fp16.tar.bz2",
    extractedDir: "kitten-nano-en-v0_1-fp16",
    requiredFiles: ["model.fp16.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    description: "KittenTTS (small, fast English TTS).",
    aliases: ["kitten"],
  },
  "kokoro-en-v0_19": {
    kind: "tts",
    archiveUrl: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2",
    extractedDir: "kokoro-en-v0_19",
    requiredFiles: ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    description: "Kokoro TTS (higher quality; larger).",
    aliases: ["kokoro"],
  },
  "pocket-tts-onnx-int8": {
    kind: "tts",
    extractedDir: "pocket-tts-onnx-int8",
    downloadFiles: [
      {
        url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx/mimi_encoder.onnx",
        relPath: "onnx/mimi_encoder.onnx",
      },
      {
        url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx/text_conditioner.onnx",
        relPath: "onnx/text_conditioner.onnx",
      },
      {
        url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx/flow_lm_main_int8.onnx",
        relPath: "onnx/flow_lm_main_int8.onnx",
      },
      {
        url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx/flow_lm_flow_int8.onnx",
        relPath: "onnx/flow_lm_flow_int8.onnx",
      },
      {
        url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx/mimi_decoder_int8.onnx",
        relPath: "onnx/mimi_decoder_int8.onnx",
      },
      {
        url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/tokenizer.model",
        relPath: "tokenizer.model",
      },
      {
        url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/reference_sample.wav",
        relPath: "reference_sample.wav",
      },
    ],
    requiredFiles: [
      "onnx/mimi_encoder.onnx",
      "onnx/text_conditioner.onnx",
      "onnx/flow_lm_main_int8.onnx",
      "onnx/flow_lm_flow_int8.onnx",
      "onnx/mimi_decoder_int8.onnx",
      "tokenizer.model",
      "reference_sample.wav",
    ],
    description: "Pocket TTS ONNX (INT8) with streaming decode support (via onnxruntime).",
    aliases: ["pocket", "pocket-tts"],
    defaultFor: "tts",
  },
} as const satisfies Record<string, SherpaOnnxCatalogEntry>;

export type SherpaOnnxModelId = keyof typeof SHERPA_ONNX_MODEL_CATALOG;
export type LocalSpeechModelId = SherpaOnnxModelId;

type ModelIdByKind<K extends SherpaOnnxModelKind> = {
  [Id in SherpaOnnxModelId]: (typeof SHERPA_ONNX_MODEL_CATALOG)[Id]["kind"] extends K
    ? Id
    : never;
}[SherpaOnnxModelId];

export type LocalSttModelId = ModelIdByKind<"stt-online"> | ModelIdByKind<"stt-offline">;
export type LocalTtsModelId = ModelIdByKind<"tts">;

const ALL_MODEL_IDS = Object.keys(SHERPA_ONNX_MODEL_CATALOG) as SherpaOnnxModelId[];

export const LOCAL_STT_MODEL_IDS = ALL_MODEL_IDS.filter(
  (id): id is LocalSttModelId => SHERPA_ONNX_MODEL_CATALOG[id].kind !== "tts"
);

export const LOCAL_TTS_MODEL_IDS = ALL_MODEL_IDS.filter(
  (id): id is LocalTtsModelId => SHERPA_ONNX_MODEL_CATALOG[id].kind === "tts"
);

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

function buildAliasMap<T extends string>(modelIds: readonly T[]): Record<string, T> {
  const aliasMap: Record<string, T> = {};
  for (const modelId of modelIds) {
    const aliases = SHERPA_ONNX_MODEL_CATALOG[modelId as SherpaOnnxModelId].aliases ?? [];
    for (const alias of aliases) {
      aliasMap[alias.trim().toLowerCase()] = modelId;
    }
  }
  return aliasMap;
}

function createAliasedModelIdSchema<T extends string>(params: {
  modelIds: readonly T[];
  aliases: Record<string, T>;
}): z.ZodType<T, z.ZodTypeDef, string> {
  const validIds = new Set(params.modelIds);
  return z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      (value): value is T =>
        validIds.has(value as T) || Object.prototype.hasOwnProperty.call(params.aliases, value),
      {
        message: "Invalid model id",
      }
    )
    .transform((value) => params.aliases[value] ?? (value as T));
}

const STT_MODEL_ALIASES = buildAliasMap(LOCAL_STT_MODEL_IDS);
const TTS_MODEL_ALIASES = buildAliasMap(LOCAL_TTS_MODEL_IDS);

export const LocalSttModelIdSchema = createAliasedModelIdSchema({
  modelIds: LOCAL_STT_MODEL_IDS,
  aliases: STT_MODEL_ALIASES,
});

export const LocalTtsModelIdSchema = createAliasedModelIdSchema({
  modelIds: LOCAL_TTS_MODEL_IDS,
  aliases: TTS_MODEL_ALIASES,
});

export type SherpaOnnxModelSpec = SherpaOnnxCatalogEntry & {
  id: SherpaOnnxModelId;
};

export function listSherpaOnnxModels(): SherpaOnnxModelSpec[] {
  return ALL_MODEL_IDS.map((id) => ({
    id,
    ...SHERPA_ONNX_MODEL_CATALOG[id],
  }));
}

export function getSherpaOnnxModelSpec(id: SherpaOnnxModelId): SherpaOnnxModelSpec {
  const spec = SHERPA_ONNX_MODEL_CATALOG[id];
  if (!spec) {
    throw new Error(`Unknown local speech model id: ${id}`);
  }
  return {
    id,
    ...spec,
  };
}
