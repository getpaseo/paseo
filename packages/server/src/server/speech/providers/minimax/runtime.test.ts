import pino from "pino";
import { describe, expect, test } from "vitest";

import { initializeMiniMaxTts } from "./runtime.js";
import { MiniMaxTTS } from "./tts.js";

describe("initializeMiniMaxTts", () => {
  test("initializes the selected TTS provider", () => {
    const result = initializeMiniMaxTts({
      providers: {
        dictationStt: { provider: "local", explicit: false },
        voiceTurnDetection: { provider: "local", explicit: false },
        voiceStt: { provider: "local", explicit: false },
        voiceTts: { provider: "minimax", explicit: true },
      },
      config: { tts: { apiKey: "test-key", model: "speech-2.8-hd" } },
      existing: null,
      logger: pino({ level: "silent" }),
    });

    expect(result.service).toBeInstanceOf(MiniMaxTTS);
    expect(result.provider).toBe(result.service);
  });
});
