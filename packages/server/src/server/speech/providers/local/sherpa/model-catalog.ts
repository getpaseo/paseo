import { z } from "zod";

export type SherpaOnnxModelKind = "stt-offline" | "tts";

type DefaultModelRole = "stt" | "tts";

interface SherpaOnnxCatalogEntryBase {
  archiveUrl: string;
  extractedDir: string;
  requiredFiles: string[];
  description: string;
  defaultFor?: DefaultModelRole;
}

export type SherpaOnnxSttArchitecture = "nemo_transducer" | "paraformer";

interface SherpaOnnxSttCatalogEntry extends SherpaOnnxCatalogEntryBase {
  kind: "stt-offline";
  architecture: SherpaOnnxSttArchitecture;
}

interface SherpaOnnxTtsCatalogEntry extends SherpaOnnxCatalogEntryBase {
  kind: "tts";
}

type SherpaOnnxCatalogEntry = SherpaOnnxSttCatalogEntry | SherpaOnnxTtsCatalogEntry;

export const SHERPA_ONNX_MODEL_CATALOG = {
  "parakeet-tdt-0.6b-v2-int8": {
    kind: "stt-offline",
    architecture: "nemo_transducer",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    description: "NVIDIA Parakeet TDT v2 (offline NeMo transducer, English).",
    defaultFor: "stt",
  },
  "parakeet-tdt-0.6b-v3-int8": {
    kind: "stt-offline",
    architecture: "nemo_transducer",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    description:
      "NVIDIA Parakeet TDT v3 (offline NeMo transducer, 25 European languages, auto-detected).",
  },
  "paraformer-zh": {
    kind: "stt-offline",
    architecture: "paraformer",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2",
    extractedDir: "sherpa-onnx-paraformer-zh-2023-09-14",
    requiredFiles: ["model.int8.onnx", "tokens.txt"],
    description: "Paraformer ZH (offline int8, Chinese/English).",
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
  return SHERPA_ONNX_MODEL_CATALOG[id].kind === "stt-offline";
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

export interface SherpaOnnxModelSpec extends SherpaOnnxCatalogEntryBase {
  kind: SherpaOnnxModelKind;
  architecture?: SherpaOnnxSttArchitecture;
  id: SherpaOnnxModelId;
}

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

export function getSherpaOnnxSttArchitecture(id: LocalSttModelId): SherpaOnnxSttArchitecture {
  const spec = SHERPA_ONNX_MODEL_CATALOG[id];
  if (spec.kind !== "stt-offline") {
    throw new Error(`Local speech model is not an offline STT model: ${id}`);
  }
  return spec.architecture;
}
