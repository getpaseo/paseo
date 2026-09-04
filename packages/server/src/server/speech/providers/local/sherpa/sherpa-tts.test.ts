import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SherpaOnnxNodeModule } from "./sherpa-onnx-node-loader.js";
import { SherpaOnnxTTS } from "./sherpa-tts.js";

const generate = vi.fn();
const free = vi.fn();
const ttsConfigs: unknown[] = [];

function createModelDir(files: string[]): string {
  const modelDir = mkdtempSync(path.join(tmpdir(), "sherpa-tts-test-"));
  for (const file of files) {
    const filePath = path.join(modelDir, file);
    writeFileSync(filePath, "");
  }
  return modelDir;
}

function fakeLoadSherpaOnnxNode(): SherpaOnnxNodeModule {
  return {
    OfflineTts: class {
      public readonly sampleRate = 24000;

      generate = generate;
      free = free;

      constructor(config: unknown) {
        ttsConfigs.push(config);
      }
    },
  } as unknown as SherpaOnnxNodeModule;
}

async function collectStream(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("SherpaOnnxTTS", () => {
  let modelDirs: string[];

  beforeEach(() => {
    generate.mockReset();
    free.mockReset();
    ttsConfigs.length = 0;
    modelDirs = [];
  });

  afterEach(() => {
    for (const modelDir of modelDirs) {
      rmSync(modelDir, { recursive: true, force: true });
    }
  });

  function trackModelDir(files: string[]): string {
    const modelDir = createModelDir(files);
    modelDirs.push(modelDir);
    return modelDir;
  }

  it("disables external buffers when calling sherpa generate", async () => {
    const modelDir = trackModelDir(["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"]);
    generate.mockReturnValue({
      samples: Float32Array.from([0, 0.5, -0.5, 0.25]),
      sampleRate: 24000,
    });

    const tts = new SherpaOnnxTTS(
      {
        preset: "kokoro-en-v0_19",
        modelDir,
        speakerId: 2,
        speed: 1.25,
        loadSherpaOnnxNode: fakeLoadSherpaOnnxNode,
      },
      pino({ level: "silent" }),
    );

    const result = await tts.synthesizeSpeech("hello");

    expect(generate).toHaveBeenCalledWith({
      text: "hello",
      sid: 2,
      speed: 1.25,
      enableExternalBuffer: false,
    });
    const audio = await collectStream(result.stream);
    expect(audio.length).toBeGreaterThan(0);
    expect(result.format).toBe("pcm;rate=24000");
  });

  it("streams synthesized pcm chunks", async () => {
    const modelDir = trackModelDir(["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"]);
    generate.mockReturnValue({
      samples: [0, 0.25, -0.25, 0.75, -0.75],
      sampleRate: 24000,
    });

    const tts = new SherpaOnnxTTS(
      {
        preset: "kokoro-en-v0_19",
        modelDir,
        loadSherpaOnnxNode: fakeLoadSherpaOnnxNode,
      },
      pino({ level: "silent" }),
    );

    const result = await tts.synthesizeSpeech("hi");
    const audio = await collectStream(result.stream);

    expect(result.format).toBe("pcm;rate=24000");
    expect(audio.length).toBeGreaterThan(0);
  });

  it("passes multilingual Kokoro lexicons when present", () => {
    const modelDir = trackModelDir([
      "model.onnx",
      "voices.bin",
      "tokens.txt",
      "espeak-ng-data",
      "lexicon-us-en.txt",
      "lexicon-zh.txt",
    ]);

    const tts = new SherpaOnnxTTS(
      {
        preset: "kokoro-multi-lang-v1_0",
        modelDir,
        loadSherpaOnnxNode: fakeLoadSherpaOnnxNode,
      },
      pino({ level: "silent" }),
    );

    expect(tts).toBeInstanceOf(SherpaOnnxTTS);
    expect(ttsConfigs).toEqual([
      {
        model: {
          kokoro: {
            model: path.join(modelDir, "model.onnx"),
            voices: path.join(modelDir, "voices.bin"),
            tokens: path.join(modelDir, "tokens.txt"),
            dataDir: path.join(modelDir, "espeak-ng-data"),
            lengthScale: 1,
            lexicon: [
              path.join(modelDir, "lexicon-us-en.txt"),
              path.join(modelDir, "lexicon-zh.txt"),
            ].join(","),
          },
        },
        numThreads: 2,
        provider: "cpu",
        maxNumSentences: 1,
      },
    ]);
  });

  it("throws when multilingual Kokoro lexicons are missing", () => {
    const modelDir = trackModelDir(["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"]);

    expect(
      () =>
        new SherpaOnnxTTS(
          {
            preset: "kokoro-multi-lang-v1_0",
            modelDir,
            loadSherpaOnnxNode: fakeLoadSherpaOnnxNode,
          },
          pino({ level: "silent" }),
        ),
    ).toThrow(/Missing TTS lexicon/);
  });
});
