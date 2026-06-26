import pino from "pino";
import { describe, expect, test } from "vitest";

import { initializeOpenAiSpeechServices } from "./runtime.js";
import { OpenAISTT } from "./stt.js";
import { OpenAITTS } from "./tts.js";

describe("initializeOpenAiSpeechServices", () => {
  test("uses REST OpenAI STT for voice and dictation", () => {
    const services = initializeOpenAiSpeechServices({
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceTurnDetection: { provider: "local", explicit: false, enabled: false },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
      openaiConfig: {
        apiKey: "sk-test",
        stt: { apiKey: "sk-test" },
        tts: { apiKey: "sk-test" },
      },
      existing: {
        turnDetectionService: null,
        sttService: null,
        ttsService: null,
        dictationSttService: null,
      },
      logger: pino({ level: "silent" }),
    });

    expect(services.sttService).toBeInstanceOf(OpenAISTT);
    expect(services.dictationSttService).toBeInstanceOf(OpenAISTT);
    expect(services.ttsService).toBeInstanceOf(OpenAITTS);
  });
});
