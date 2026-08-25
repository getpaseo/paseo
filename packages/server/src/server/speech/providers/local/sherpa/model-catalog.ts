import { z } from "zod";

export type SherpaOnnxModelKind = "stt-offline" | "tts" | "vad";

type DefaultModelRole = "stt" | "tts" | "vad";

export interface SherpaOnnxModelVoice {
  id: number;
  name: string;
  language: string;
}

export interface SherpaOnnxCatalogEntry {
  id: string;
  kind: SherpaOnnxModelKind;
  displayName: string;
  archiveUrl: string;
  extractedDir: string;
  requiredFiles: string[];
  description: string;
  languages: string[];
  sizeMB: number;
  sha256?: string;
  runtimeSupported?: boolean;
  defaultFor?: DefaultModelRole;
  voices?: SherpaOnnxModelVoice[];
}

const KOKORO_MULTI_V1_0_VOICES: SherpaOnnxModelVoice[] = [
  { id: 0, name: "af_alloy", language: "en" },
  { id: 1, name: "af_aoede", language: "en" },
  { id: 2, name: "af_bella", language: "en" },
  { id: 3, name: "af_heart", language: "en" },
  { id: 4, name: "af_jessica", language: "en" },
  { id: 5, name: "af_kore", language: "en" },
  { id: 6, name: "af_nicole", language: "en" },
  { id: 7, name: "af_nova", language: "en" },
  { id: 8, name: "af_river", language: "en" },
  { id: 9, name: "af_sarah", language: "en" },
  { id: 10, name: "af_sky", language: "en" },
  { id: 11, name: "am_adam", language: "en" },
  { id: 12, name: "am_echo", language: "en" },
  { id: 13, name: "am_eric", language: "en" },
  { id: 14, name: "am_fenrir", language: "en" },
  { id: 15, name: "am_liam", language: "en" },
  { id: 16, name: "am_michael", language: "en" },
  { id: 17, name: "am_onyx", language: "en" },
  { id: 18, name: "am_puck", language: "en" },
  { id: 19, name: "am_santa", language: "en" },
  { id: 20, name: "bf_alice", language: "en" },
  { id: 21, name: "bf_emma", language: "en" },
  { id: 22, name: "bf_isabella", language: "en" },
  { id: 23, name: "bf_lily", language: "en" },
  { id: 24, name: "bm_daniel", language: "en" },
  { id: 25, name: "bm_fable", language: "en" },
  { id: 26, name: "bm_george", language: "en" },
  { id: 27, name: "bm_lewis", language: "en" },
  { id: 28, name: "ef_dora", language: "es" },
  { id: 29, name: "em_alex", language: "es" },
  { id: 30, name: "ff_siwis", language: "fr" },
  { id: 31, name: "hf_alpha", language: "hi" },
  { id: 32, name: "hf_beta", language: "hi" },
  { id: 33, name: "hm_omega", language: "hi" },
  { id: 34, name: "hm_psi", language: "hi" },
  { id: 35, name: "if_sara", language: "it" },
  { id: 36, name: "im_nicola", language: "it" },
  { id: 37, name: "jf_alpha", language: "ja" },
  { id: 38, name: "jf_gongitsune", language: "ja" },
  { id: 39, name: "jf_nezumi", language: "ja" },
  { id: 40, name: "jf_tebukuro", language: "ja" },
  { id: 41, name: "jm_kumo", language: "ja" },
  { id: 42, name: "pf_dora", language: "pt-BR" },
  { id: 43, name: "pm_alex", language: "pt-BR" },
  { id: 44, name: "pm_santa", language: "pt-BR" },
  { id: 45, name: "zf_xiaobei", language: "zh" },
  { id: 46, name: "zf_xiaoni", language: "zh" },
  { id: 47, name: "zf_xiaoxiao", language: "zh" },
  { id: 48, name: "zf_xiaoyi", language: "zh" },
  { id: 49, name: "zm_yunjian", language: "zh" },
  { id: 50, name: "zm_yunxi", language: "zh" },
  { id: 51, name: "zm_yunxia", language: "zh" },
  { id: 52, name: "zm_yunyang", language: "zh" },
];

export const SHERPA_ONNX_MODEL_CATALOG = {
  "parakeet-tdt-0.6b-v3-int8": {
    id: "parakeet-tdt-0.6b-v3-int8",
    kind: "stt-offline",
    displayName: "Parakeet TDT 0.6B v3",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    description: "NVIDIA Parakeet TDT v3 (NeMo transducer, 25 European languages, auto-detected).",
    languages: [
      "bg",
      "hr",
      "cs",
      "da",
      "nl",
      "en",
      "et",
      "fi",
      "fr",
      "de",
      "el",
      "hu",
      "it",
      "lv",
      "lt",
      "mt",
      "pl",
      "pt",
      "ro",
      "sk",
      "sl",
      "es",
      "sv",
      "ru",
      "uk",
    ],
    sizeMB: 465,
    sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
    runtimeSupported: true,
    defaultFor: "stt",
  },
  "whisper-large-v3-turbo-int8": {
    id: "whisper-large-v3-turbo-int8",
    kind: "stt-offline",
    displayName: "Whisper Large v3 Turbo",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2",
    extractedDir: "sherpa-onnx-whisper-turbo",
    requiredFiles: ["turbo-tokens.txt"],
    description: "OpenAI Whisper Large v3 Turbo (multilingual, 99 languages, 8× faster than large-v3).",
    languages: ["multi"],
    sizeMB: 538,
    runtimeSupported: true,
  },





  "kokoro-multi-v1_0": {
    id: "kokoro-multi-v1_0",
    kind: "tts",
    displayName: "Kokoro TTS v1.0 Multi (82M)",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
    extractedDir: "kokoro-multi-lang-v1_0",
    requiredFiles: ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    description:
      "Kokoro 82M multilingual (53 voices across en-US, en-GB, es-ES, fr-FR, hi-IN, it-IT, ja-JP, pt-BR, zh-CN).",
    languages: [
      "en",
      "pt-BR",
      "es",
      "fr",
      "hi",
      "it",
      "ja",
      "zh",
      "multi",
    ],
    sizeMB: 333,
    sha256: "c133d26353d776da730870dac7da07dbfc9a5e3bc80cc5e8e83ab6e823be7046",
    runtimeSupported: true,
    defaultFor: "tts",
    voices: KOKORO_MULTI_V1_0_VOICES,
  },
  "silero-vad": {
    id: "silero-vad",
    kind: "vad",
    displayName: "Silero VAD (Voice Activity Detection)",
    archiveUrl: "",
    extractedDir: "silero-vad",
    requiredFiles: ["silero_vad.onnx"],
    description: "Silero Voice Activity Detection engine for real-time speech boundary detection.",
    languages: ["universal"],
    sizeMB: 2,
    runtimeSupported: true,
    defaultFor: "vad",
  },
} as const satisfies Record<string, SherpaOnnxCatalogEntry>;

export type SherpaOnnxModelId = keyof typeof SHERPA_ONNX_MODEL_CATALOG;
export type LocalSpeechModelId = SherpaOnnxModelId;

type RuntimeModelIdByKind<K extends SherpaOnnxModelKind> = {
  [Id in SherpaOnnxModelId]: (typeof SHERPA_ONNX_MODEL_CATALOG)[Id]["kind"] extends K
    ? (typeof SHERPA_ONNX_MODEL_CATALOG)[Id]["runtimeSupported"] extends true
      ? Id
      : never
    : never;
}[SherpaOnnxModelId];

export type LocalSttModelId = RuntimeModelIdByKind<"stt-offline">;
export type LocalTtsModelId = RuntimeModelIdByKind<"tts">;

const ALL_MODEL_IDS: SherpaOnnxModelId[] = Object.keys(SHERPA_ONNX_MODEL_CATALOG).filter(
  (k): k is SherpaOnnxModelId => k in SHERPA_ONNX_MODEL_CATALOG,
);

function isLocalSttModelId(id: SherpaOnnxModelId): id is LocalSttModelId {
  const entry = SHERPA_ONNX_MODEL_CATALOG[id] as SherpaOnnxCatalogEntry;
  return entry.kind === "stt-offline" && entry.runtimeSupported !== false;
}

function isLocalTtsModelId(id: SherpaOnnxModelId): id is LocalTtsModelId {
  const entry = SHERPA_ONNX_MODEL_CATALOG[id] as SherpaOnnxCatalogEntry;
  return entry.kind === "tts" && entry.runtimeSupported !== false;
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
  return ALL_MODEL_IDS.map((id) => ({ ...SHERPA_ONNX_MODEL_CATALOG[id] } as SherpaOnnxModelSpec));
}

export function getSherpaOnnxModelSpec(id: SherpaOnnxModelId): SherpaOnnxModelSpec {
  const spec = SHERPA_ONNX_MODEL_CATALOG[id];
  if (!spec) {
    throw new Error(`Unknown local speech model id: ${id}`);
  }
  return spec as SherpaOnnxModelSpec;
}
