import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { engineFiles, getLocalTtsEngine, type LocalTtsModelId } from "./model-catalog.js";
import { SherpaOnnxTTS } from "./sherpa-tts.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createTts(
  numThreads?: number,
  beforeGenerate?: () => Promise<void>,
  modelId: LocalTtsModelId = "kokoro-en-v0_19",
) {
  const modelDir = mkdtempSync(join(tmpdir(), "paseo-tts-"));
  directories.push(modelDir);
  // Data directories have no extension; everything else is a model file.
  for (const name of engineFiles(getLocalTtsEngine(modelId))) {
    if (name.includes(".")) writeFileSync(join(modelDir, name), "");
    else mkdirSync(join(modelDir, name));
  }
  let nativeConfig: unknown;
  const requests: unknown[] = [];
  const released: boolean[] = [];
  const tts = new SherpaOnnxTTS(
    {
      modelId,
      modelDir,
      engine: getLocalTtsEngine(modelId),
      numThreads,
    },
    pino({ level: "silent" }),
    () => ({
      OfflineTts: class {
        sampleRate = 24000;
        free() {
          released.push(true);
        }
        constructor(config: unknown) {
          nativeConfig = config;
        }
        async generateAsync(request: unknown) {
          await beforeGenerate?.();
          return this.generate(request);
        }
        generate(request: unknown) {
          requests.push(request);
          return { samples: Float32Array.from([0, 0.5, -0.5, 0.25]), sampleRate: 24000 };
        }
      },
    }),
  );
  return { tts, requests, nativeConfig, released };
}

async function yieldNativeQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function holdNativeSynthesis() {
  const pending: Array<() => void> = [];
  function wait() {
    return new Promise<void>((resolve) => pending.push(resolve));
  }
  return { pending, wait };
}

describe("SherpaOnnxTTS", () => {
  it("requests Electron-compatible copied samples and returns PCM audio", async () => {
    const { tts, requests } = createTts();
    const result = await tts.synthesizeSpeech("hello");
    expect(requests).toEqual([{ text: "hello", sid: 0, speed: 1, enableExternalBuffer: false }]);
    expect(result.format).toBe("pcm;rate=24000");
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).length).toBe(8);
  });

  it("keeps the event loop available and serializes native synthesis", async () => {
    const { pending, wait } = holdNativeSynthesis();
    const { tts, requests } = createTts(undefined, wait);
    const first = tts.synthesizeSpeech("first");
    const second = tts.synthesizeSpeech("second");
    try {
      await yieldNativeQueue();
      expect(requests).toEqual([]);
      expect(pending).toHaveLength(1);
      pending.shift()!();
      const audio = await first;
      audio.stream.destroy();
      await yieldNativeQueue();
      expect(requests).toHaveLength(1);
      expect(pending).toHaveLength(1);
      pending.shift()!();
      (await second).stream.destroy();
      expect(requests.map((request) => (request as { text: string }).text)).toEqual([
        "first",
        "second",
      ]);
    } finally {
      for (const release of pending) release();
      await Promise.allSettled([first, second]);
      tts.free();
    }
  });

  it("continues queued synthesis after a native failure", async () => {
    let attempts = 0;
    const { tts, requests } = createTts(undefined, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("generation failed");
    });
    const first = tts.synthesizeSpeech("first");
    const second = tts.synthesizeSpeech("second");
    await expect(first).rejects.toThrow("generation failed");
    (await second).stream.destroy();
    expect(requests).toEqual([{ text: "second", sid: 0, speed: 1, enableExternalBuffer: false }]);
    tts.free();
  });

  it("waits for active native synthesis before freeing and drops queued synthesis", async () => {
    const { pending, wait } = holdNativeSynthesis();
    const { tts, requests, released } = createTts(undefined, wait);
    const first = tts.synthesizeSpeech("first");
    const second = tts.synthesizeSpeech("second");
    const rejected = expect(second).rejects.toThrow("TTS provider closed");
    await yieldNativeQueue();
    tts.free();
    expect(released).toEqual([]);
    pending.shift()!();
    (await first).stream.destroy();
    await rejected;
    await yieldNativeQueue();
    expect(requests).toHaveLength(1);
    expect(released).toEqual([true]);
    await expect(tts.synthesizeSpeech("third")).rejects.toThrow("TTS provider closed");
  });

  it.each([undefined, 4])(
    "passes the requested thread count at the native model boundary (%s)",
    (threads) => {
      const { nativeConfig } = createTts(threads);
      expect(nativeConfig).toMatchObject({ model: { numThreads: threads ?? 2, provider: "cpu" } });
      expect(nativeConfig).not.toHaveProperty("numThreads");
      expect(nativeConfig).not.toHaveProperty("provider");
    },
  );

  it("loads Piper voices through the vits engine", () => {
    const { nativeConfig } = createTts(undefined, undefined, "piper-de-thorsten");
    expect(nativeConfig).toMatchObject({
      model: {
        vits: {
          model: expect.stringMatching(/de_DE-thorsten-medium\.onnx$/),
          tokens: expect.stringMatching(/tokens\.txt$/),
          dataDir: expect.stringMatching(/espeak-ng-data$/),
        },
      },
    });
    expect(nativeConfig).not.toHaveProperty("model.kokoro");
  });

  it("gives multi-language Kokoro its lexicons, dictionary and number rules", () => {
    const { nativeConfig } = createTts(undefined, undefined, "kokoro-int8-multi-lang-v1_1");
    expect(nativeConfig).toMatchObject({
      model: {
        kokoro: {
          lexicon: expect.stringMatching(/lexicon-us-en\.txt,.*lexicon-zh\.txt$/),
          dictDir: expect.stringMatching(/dict$/),
        },
      },
      ruleFsts: expect.stringMatching(/date-zh\.fst,.*phone-zh\.fst,.*number-zh\.fst$/),
    });
  });
});
