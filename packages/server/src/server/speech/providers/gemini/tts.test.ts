import type { Readable } from "node:stream";

import pino from "pino";
import { describe, expect, test } from "vitest";

import type { GeminiSpeechSynthesisApi, GeminiTtsRequest } from "./tts.js";
import { GeminiTTS } from "./tts.js";

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("GeminiTTS", () => {
  test("returns 24 kHz PCM speech with the configured model and voice", async () => {
    const requests: GeminiTtsRequest[] = [];
    const api: GeminiSpeechSynthesisApi = {
      async synthesize(request) {
        requests.push(request);
        return { pcm16: Buffer.from([1, 0, 2, 0]), sampleRate: 24000 };
      },
    };
    const provider = new GeminiTTS({
      apiKey: "gemini-test-key",
      config: { model: "gemini-3.1-flash-tts-preview", voice: "Kore" },
      logger: pino({ level: "silent" }),
      api,
    });

    const speech = await provider.synthesizeSpeech("  Hello from Paseo.  ");

    expect(requests).toEqual([
      {
        model: "gemini-3.1-flash-tts-preview",
        voice: "Kore",
        text: "Hello from Paseo.",
      },
    ]);
    expect(speech.format).toBe("pcm;rate=24000");
    await expect(readStream(speech.stream)).resolves.toEqual(Buffer.from([1, 0, 2, 0]));
  });

  test("hides provider errors", async () => {
    const api: GeminiSpeechSynthesisApi = {
      async synthesize() {
        throw new Error("internal API response");
      },
    };
    const provider = new GeminiTTS({
      apiKey: "gemini-test-key",
      config: { model: "gemini-3.1-flash-tts-preview", voice: "Kore" },
      logger: pino({ level: "silent" }),
      api,
    });

    await expect(provider.synthesizeSpeech("Hello")).rejects.toHaveProperty(
      "message",
      "Gemini TTS synthesis failed",
    );
  });
});
