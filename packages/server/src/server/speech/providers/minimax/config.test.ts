import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "../../../persisted-config.js";
import {
  MINIMAX_TTS_AUDIO_FORMATS,
  MINIMAX_TTS_MODELS,
  resolveMiniMaxSpeechConfig,
} from "./config.js";

describe("resolveMiniMaxSpeechConfig", () => {
  test("registers every supported model and audio format", () => {
    expect(MINIMAX_TTS_MODELS).toEqual([
      "speech-2.8-hd",
      "speech-2.8-turbo",
      "speech-2.6-hd",
      "speech-2.6-turbo",
      "speech-02-hd",
      "speech-02-turbo",
      "speech-01-hd",
      "speech-01-turbo",
    ]);
    expect(MINIMAX_TTS_AUDIO_FORMATS).toEqual(["mp3", "wav", "flac", "pcm"]);
  });

  test("resolves China routing and feature-level model settings", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: {
        minimax: { apiKey: "test-key", region: "cn_zh" },
      },
      features: {
        voiceMode: {
          tts: {
            provider: "minimax",
            model: "speech-2.6-turbo",
            voice: "test-voice",
          },
        },
      },
    });
    const config = resolveMiniMaxSpeechConfig({
      env: { MINIMAX_TTS_FORMAT: "flac" },
      persisted,
      providers: {
        dictationStt: { provider: "local", explicit: false },
        voiceTurnDetection: { provider: "local", explicit: false },
        voiceStt: { provider: "local", explicit: false },
        voiceTts: { provider: "minimax", explicit: true },
      },
    });

    expect(config?.tts).toEqual({
      apiKey: "test-key",
      model: "speech-2.6-turbo",
      region: "cn_zh",
      responseFormat: "flac",
      voiceId: "test-voice",
    });
  });
});
