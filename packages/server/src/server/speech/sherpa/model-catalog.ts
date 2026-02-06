export type SherpaOnnxModelKind = "stt-online" | "stt-offline" | "tts";

export type SherpaOnnxModelId =
  | "zipformer-bilingual-zh-en-2023-02-20"
  | "paraformer-bilingual-zh-en"
  | "parakeet-tdt-0.6b-v3-int8"
  | "kitten-nano-en-v0_1-fp16"
  | "kokoro-en-v0_19"
  | "pocket-tts-onnx-int8";

export type SherpaOnnxModelSpec = {
  id: SherpaOnnxModelId;
  kind: SherpaOnnxModelKind;
  archiveUrl?: string;
  downloadFiles?: Array<{ url: string; relPath: string }>;
  extractedDir: string;
  requiredFiles: string[];
  description: string;
};

export const SHERPA_ONNX_MODEL_CATALOG: Record<SherpaOnnxModelId, SherpaOnnxModelSpec> = {
  "zipformer-bilingual-zh-en-2023-02-20": {
    id: "zipformer-bilingual-zh-en-2023-02-20",
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
  },
  "paraformer-bilingual-zh-en": {
    id: "paraformer-bilingual-zh-en",
    kind: "stt-online",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
    extractedDir: "sherpa-onnx-streaming-paraformer-bilingual-zh-en",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
    description: "Streaming Paraformer (often strong accuracy; heavier).",
  },
  "parakeet-tdt-0.6b-v3-int8": {
    id: "parakeet-tdt-0.6b-v3-int8",
    kind: "stt-offline",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    extractedDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    description: "NVIDIA Parakeet TDT v3 (offline NeMo transducer, multilingual).",
  },
  "kitten-nano-en-v0_1-fp16": {
    id: "kitten-nano-en-v0_1-fp16",
    kind: "tts",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_1-fp16.tar.bz2",
    extractedDir: "kitten-nano-en-v0_1-fp16",
    requiredFiles: ["model.fp16.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    description: "KittenTTS (small, fast English TTS).",
  },
  "kokoro-en-v0_19": {
    id: "kokoro-en-v0_19",
    kind: "tts",
    archiveUrl: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2",
    extractedDir: "kokoro-en-v0_19",
    requiredFiles: ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    description: "Kokoro TTS (higher quality; larger).",
  },
  "pocket-tts-onnx-int8": {
    id: "pocket-tts-onnx-int8",
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
  },
};

export function listSherpaOnnxModels(): SherpaOnnxModelSpec[] {
  return Object.values(SHERPA_ONNX_MODEL_CATALOG);
}

export function getSherpaOnnxModelSpec(id: SherpaOnnxModelId): SherpaOnnxModelSpec {
  const spec = SHERPA_ONNX_MODEL_CATALOG[id];
  if (!spec) {
    throw new Error(`Unknown sherpa-onnx model id: ${id}`);
  }
  return spec;
}
