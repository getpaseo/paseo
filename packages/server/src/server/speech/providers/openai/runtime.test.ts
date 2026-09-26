import pino from "pino";
import { describe, expect, test } from "vitest";

import { getOpenAiSpeechAvailability, initializeOpenAiSpeechServices } from "./runtime.js";
import { OpenAISTT } from "./stt.js";
import { OpenAITTS } from "./tts.js";

describe("initializeOpenAiSpeechServices", () => {
  test("initializes explicitly unauthenticated local endpoints", () => {
    const openaiConfig = {
      stt: { auth: "none" as const, baseUrl: "http://127.0.0.1:18081/v1" },
      tts: { auth: "none" as const, baseUrl: "http://127.0.0.1:18082/v1" },
    };
    expect(getOpenAiSpeechAvailability(openaiConfig)).toEqual({
      stt: true,
      tts: true,
      dictationStt: true,
    });
    const services = initializeOpenAiSpeechServices({
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceTurnDetection: { provider: "local", explicit: false, enabled: false },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
      openaiConfig,
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
    expect(getOpenAiSpeechAvailability(undefined)).toEqual({
      stt: false,
      tts: false,
      dictationStt: false,
    });
  });
  test("uses REST OpenAI STT for voice and dictation", () => {
    const services = initializeOpenAiSpeechServices({
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceTurnDetection: { provider: "local", explicit: false, enabled: false },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
      openaiConfig: {
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
