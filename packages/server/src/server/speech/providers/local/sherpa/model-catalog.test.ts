import { describe, expect, test } from "vitest";

import {
  LocalSttModelIdSchema,
  getSherpaOnnxModelSpec,
  getSherpaOnnxSttArchitecture,
} from "./model-catalog.js";

describe("sherpa onnx model catalog", () => {
  test("registers the int8 Paraformer model as a local STT model", () => {
    const spec = getSherpaOnnxModelSpec("paraformer-zh");

    expect(LocalSttModelIdSchema.parse(" PARAFORMER-ZH ")).toBe("paraformer-zh");
    expect(getSherpaOnnxSttArchitecture("paraformer-zh")).toBe("paraformer");
    expect(spec).toMatchObject({
      kind: "stt-offline",
      architecture: "paraformer",
      archiveUrl:
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2",
      extractedDir: "sherpa-onnx-paraformer-zh-2023-09-14",
      requiredFiles: ["model.int8.onnx", "tokens.txt"],
    });
  });

  test("carries architecture only on offline STT specs", () => {
    const parakeet = getSherpaOnnxModelSpec("parakeet-tdt-0.6b-v2-int8");
    const kokoro = getSherpaOnnxModelSpec("kokoro-en-v0_19");

    expect(parakeet).toMatchObject({ kind: "stt-offline", architecture: "nemo_transducer" });
    expect(kokoro).toMatchObject({ kind: "tts" });
    expect("architecture" in kokoro).toBe(false);
  });
});
