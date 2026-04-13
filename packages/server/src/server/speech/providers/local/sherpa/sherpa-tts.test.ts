import { describe, expect, it, vi, beforeEach } from "vitest";
import pino from "pino";

const generate = vi.fn();
const free = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("./sherpa-onnx-node-loader.js", () => ({
  loadSherpaOnnxNode: () => ({
    OfflineTts: class {
      public readonly sampleRate = 24000;

      constructor(_config: unknown) {}

      generate = generate;
      free = free;
    },
  }),
}));

describe("SherpaOnnxTTS", () => {
  beforeEach(() => {
    generate.mockReset();
    free.mockReset();
  });

  it("disables external buffers when calling sherpa generate", async () => {
    generate.mockReturnValue({
      samples: Float32Array.from([0, 0.5, -0.5, 0.25]),
      sampleRate: 24000,
    });

    const { SherpaOnnxTTS } = await import("./sherpa-tts.js");
    const tts = new SherpaOnnxTTS(
      {
        preset: "kokoro-en-v0_19",
        modelDir: "/tmp/fake-model",
      },
      pino({ level: "silent" }),
    );

    const result = await tts.synthesizeSpeech("hello");

    expect(generate).toHaveBeenCalledWith({
      text: "hello",
      sid: 0,
      speed: 1,
      enableExternalBuffer: false,
    });
    expect(result.format).toBe("pcm;rate=24000");
  });
});
