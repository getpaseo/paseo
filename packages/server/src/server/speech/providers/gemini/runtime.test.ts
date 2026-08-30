import pino from "pino";
import { describe, expect, test } from "vitest";

import { initializeGeminiSpeechServices } from "./runtime.js";
import { GeminiSTT } from "./stt.js";
import { GeminiTTS } from "./tts.js";

describe("initializeGeminiSpeechServices", () => {
  test("initializes Gemini STT independently for voice and dictation", () => {
    const services = initializeGeminiSpeechServices({
      providers: {
        dictationStt: { provider: "gemini", explicit: true },
        voiceTurnDetection: { provider: "local", explicit: false },
        voiceStt: { provider: "gemini", explicit: true },
        voiceTts: { provider: "gemini", explicit: true },
      },
      config: {
        apiKey: "gemini-test-key",
        dictationStt: { model: "gemini-3.5-transcribe-live", mode: "smart" },
        voiceStt: { model: "gemini-3.5-transcribe-live", mode: "verbatim" },
        tts: { model: "gemini-3.1-flash-tts-preview", voice: "Kore" },
      },
      existing: {
        turnDetectionService: null,
        sttService: null,
        ttsService: null,
        dictationSttService: null,
      },
      logger: pino({ level: "silent" }),
    });

    expect(services.sttService).toBeInstanceOf(GeminiSTT);
    expect(services.dictationSttService).toBeInstanceOf(GeminiSTT);
    expect(services.sttService).not.toBe(services.dictationSttService);
    expect(services.ttsService).toBeInstanceOf(GeminiTTS);
  });
});
