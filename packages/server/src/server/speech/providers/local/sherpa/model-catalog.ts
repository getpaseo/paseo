import { z } from "zod";

export type SherpaOnnxModelKind = "stt-offline" | "tts";

type DefaultModelRole = "stt" | "tts";

export type SherpaOfflineRecognizerModelSpec =
  | {
      kind: "nemo_transducer";
      encoder: string;
      decoder: string;
      joiner: string;
      tokens: string;
    }
  | {
      kind: "sense_voice";
      model: string;
      tokens: string;
      language: "auto";
      useInverseTextNormalization: boolean;
    };

interface SherpaOnnxCatalogEntryBase {
  kind: SherpaOnnxModelKind;
  archiveUrl: string;
  extractedDir: string;
  requiredFiles: string[];
  directFiles?: Array<{
    path: string;
    urls: string[];
  }>;
  description: string;
  defaultFor?: DefaultModelRole;
}

type SherpaOnnxCatalogEntry =
  | (SherpaOnnxCatalogEntryBase & {
      kind: "stt-offline";
      recognizer: SherpaOfflineRecognizerModelSpec;
    })
  | (SherpaOnnxCatalogEntryBase & {
      kind: "tts";
    });

export const SHERPA_ONNX_MODEL_CATALOG = {
  "parakeet-tdt-0.6b-v2-int8": {
    kind: "stt-offline",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    recognizer: {
      kind: "nemo_transducer",
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx",
      tokens: "tokens.txt",
    },
    description: "NVIDIA Parakeet TDT v2 (offline NeMo transducer, English).",
    defaultFor: "stt",
  },
  "parakeet-tdt-0.6b-v3-int8": {
    kind: "stt-offline",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    recognizer: {
      kind: "nemo_transducer",
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx",
      tokens: "tokens.txt",
    },
    description:
      "NVIDIA Parakeet TDT v3 (offline NeMo transducer, 25 European languages, auto-detected).",
  },
  "sense-voice-zh-en-ja-ko-yue-int8-2025-09-09": {
    kind: "stt-offline",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2",
    extractedDir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
    requiredFiles: ["model.int8.onnx", "tokens.txt"],
    directFiles: [
      {
        path: "model.int8.onnx",
        urls: [
          "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/model.int8.onnx?download=true",
          "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/model.int8.onnx?download=true",
        ],
      },
      {
        path: "tokens.txt",
        urls: [
          "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/tokens.txt?download=true",
          "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/tokens.txt?download=true",
        ],
      },
    ],
    recognizer: {
      kind: "sense_voice",
      model: "model.int8.onnx",
      tokens: "tokens.txt",
      language: "auto",
      useInverseTextNormalization: true,
    },
    description:
      "SenseVoice int8 (offline, Chinese/English/Japanese/Korean/Cantonese, auto-detected).",
  },
  "kokoro-en-v0_19": {
    kind: "tts",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2",
    extractedDir: "kokoro-en-v0_19",
    requiredFiles: ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    description: "Kokoro TTS (higher quality; larger).",
    defaultFor: "tts",
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

export type SherpaOnnxModelSpec = SherpaOnnxCatalogEntry & {
  id: SherpaOnnxModelId;
};

export function listSherpaOnnxModels(): SherpaOnnxModelSpec[] {
  return ALL_MODEL_IDS.map((id) => Object.assign({ id }, SHERPA_ONNX_MODEL_CATALOG[id]));
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
