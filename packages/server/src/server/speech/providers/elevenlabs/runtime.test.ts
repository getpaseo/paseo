import pino from "pino";
import { describe, expect, test } from "vitest";

import type { TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import {
  getElevenLabsSpeechAvailability,
  initializeElevenLabsSpeechServices,
  validateElevenLabsCredentialRequirements,
} from "./runtime.js";
import { ElevenLabsTTS } from "./tts.js";
import type { ElevenLabsSpeechProviderConfig } from "./config.js";

const ALL_PROVIDING: RequestedSpeechProviders = {
  dictationStt: { provider: "openai", explicit: true },
  voiceTurnDetection: { provider: "openai", explicit: true },
  voiceStt: { provider: "openai", explicit: true },
  voiceTts: { provider: "elevenlabs", explicit: true },
};

describe("ElevenLabs speech provider", () => {
  test("availability is true only when apiKey and voiceId are present", () => {
    expect(
      getElevenLabsSpeechAvailability({
        apiKey: "k",
        tts: { apiKey: "k", voiceId: "v" },
      }),
    ).toEqual({ tts: true });
    expect(
      getElevenLabsSpeechAvailability({
        apiKey: "k",
        tts: { apiKey: "k", voiceId: "" },
      }),
    ).toEqual({ tts: false });
    expect(getElevenLabsSpeechAvailability(undefined)).toEqual({ tts: false });
  });

  test("creates ElevenLabsTTS when voiceTts is elevenlabs and credentials are present", () => {
    const config: ElevenLabsSpeechProviderConfig = {
      apiKey: "k",
      tts: { apiKey: "k", voiceId: "voice-1" },
    };

    const services = initializeElevenLabsSpeechServices({
      providers: ALL_PROVIDING,
      elevenlabsConfig: config,
      existing: {
        turnDetectionService: null,
        sttService: null,
        ttsService: null,
        dictationSttService: null,
      },
      logger: pino({ level: "silent" }),
    });

    expect(services.ttsService).toBeInstanceOf(ElevenLabsTTS);
  });

  test("passes through existing services when voiceTts is not elevenlabs", () => {
    const existingTts = { id: "openai" } as unknown as TextToSpeechProvider;
    const providers: RequestedSpeechProviders = {
      ...ALL_PROVIDING,
      voiceTts: { provider: "openai", explicit: true },
    };

    const services = initializeElevenLabsSpeechServices({
      providers,
      elevenlabsConfig: {
        apiKey: "k",
        tts: { apiKey: "k", voiceId: "v" },
      },
      existing: {
        turnDetectionService: null,
        sttService: null,
        ttsService: existingTts,
        dictationSttService: null,
      },
      logger: pino({ level: "silent" }),
    });

    expect(services.ttsService).toBe(existingTts);
  });

  test("validateElevenLabsCredentialRequirements logs nothing when everything is consistent", () => {
    const logger = pino({ level: "silent" });
    expect(() =>
      validateElevenLabsCredentialRequirements({
        providers: ALL_PROVIDING,
        elevenlabsConfig: {
          apiKey: "k",
          tts: { apiKey: "k", voiceId: "v" },
        },
        logger,
      }),
    ).not.toThrow();
  });
});
