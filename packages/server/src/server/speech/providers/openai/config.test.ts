import { describe, expect, test } from "vitest";
import { PersistedConfigSchema } from "../../../persisted-config.js";
import { resolveOpenAiSpeechConfig } from "./config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";

const ALL_OPENAI: RequestedSpeechProviders = {
  dictationStt: { provider: "openai", explicit: true },
  voiceTurnDetection: { provider: "local", explicit: false },
  voiceStt: { provider: "openai", explicit: true },
  voiceTts: { provider: "openai", explicit: true },
};
function resolve(input: unknown, env: NodeJS.ProcessEnv = {}) {
  return resolveOpenAiSpeechConfig({
    persisted: PersistedConfigSchema.parse(input),
    env,
    providers: ALL_OPENAI,
  });
}

describe("resolveOpenAiSpeechConfig", () => {
  test("treats empty credentials as unset", () => {
    expect(resolve({}, { OPENAI_API_KEY: "", OPENAI_STT_API_KEY: " " })).toBeUndefined();
  });
  test("uses endpoint env before global env and ignores empty fallbacks", () => {
    const result = resolve(
      {},
      {
        OPENAI_API_KEY: " global ",
        OPENAI_BASE_URL: " https://global/v1 ",
        OPENAI_STT_API_KEY: " stt ",
        OPENAI_STT_BASE_URL: " https://stt/v1 ",
        OPENAI_TTS_API_KEY: " ",
        OPENAI_TTS_BASE_URL: "",
      },
    );
    expect(result?.dictationStt).toEqual({ apiKey: "stt", baseUrl: "https://stt/v1" });
    expect(result?.stt).toEqual({ apiKey: "stt", baseUrl: "https://stt/v1" });
    expect(result?.tts).toEqual({
      apiKey: "global",
      baseUrl: "https://global/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "pcm",
    });
  });
  test("each site wins over endpoint and global env credentials and URL", () => {
    const result = resolve(
      {
        features: {
          dictation: {
            stt: {
              provider: "openai",
              apiKey: "dictation",
              baseUrl: "https://dictation/v1",
              model: "dictation-model",
              confidenceThreshold: -1,
            },
          },
          voiceMode: {
            stt: {
              provider: "openai",
              apiKey: "voice",
              baseUrl: "https://voice/v1",
              model: "voice-model",
              confidenceThreshold: -2,
            },
            tts: {
              provider: "openai",
              apiKey: "tts",
              baseUrl: "https://tts/v1",
              model: "kokoro-v1:Q8_0",
              voice: "Aiden",
            },
          },
        },
      },
      {
        OPENAI_API_KEY: "global",
        OPENAI_BASE_URL: "https://global/v1",
        OPENAI_STT_API_KEY: "endpoint",
        OPENAI_STT_BASE_URL: "https://endpoint/v1",
        OPENAI_TTS_API_KEY: "endpoint",
        OPENAI_TTS_BASE_URL: "https://endpoint/v1",
      },
    );
    expect(result?.dictationStt).toEqual({
      apiKey: "dictation",
      baseUrl: "https://dictation/v1",
      model: "dictation-model",
      confidenceThreshold: -1,
    });
    expect(result?.stt).toEqual({
      apiKey: "voice",
      baseUrl: "https://voice/v1",
      model: "voice-model",
      confidenceThreshold: -2,
    });
    expect(result?.tts).toEqual({
      apiKey: "tts",
      baseUrl: "https://tts/v1",
      model: "kokoro-v1:Q8_0",
      voice: "Aiden",
      responseFormat: "pcm",
    });
  });
  test("env overrides model, voice and threshold at every OpenAI site", () => {
    const result = resolve(
      {
        features: {
          dictation: { stt: { provider: "openai", model: "dictation", confidenceThreshold: -1 } },
          voiceMode: {
            stt: { provider: "openai", model: "voice", confidenceThreshold: -2 },
            tts: { provider: "openai", model: "configured", voice: "Aiden" },
          },
        },
      },
      {
        OPENAI_API_KEY: "key",
        STT_MODEL: "override",
        TTS_MODEL: "tts-override",
        TTS_VOICE: "Nova",
        STT_CONFIDENCE_THRESHOLD: "-3",
      },
    );
    expect(result?.dictationStt).toEqual({
      apiKey: "key",
      model: "override",
      confidenceThreshold: -3,
    });
    expect(result?.stt).toEqual({ apiKey: "key", model: "override", confidenceThreshold: -3 });
    expect(result?.tts).toMatchObject({ model: "tts-override", voice: "Nova" });
  });
  test("only configures endpoints with credentials and ignores unused TTS options", () => {
    const result = resolve(
      { features: { dictation: { stt: { provider: "openai", apiKey: "dictation" } } } },
      { TTS_VOICE: "arbitrary", TTS_MODEL: "arbitrary" },
    );
    expect(result).toEqual({ dictationStt: { apiKey: "dictation" } });
  });
  test("does not borrow another site's key", () => {
    const result = resolve({
      features: { voiceMode: { stt: { provider: "openai", apiKey: "voice-only" } } },
    });
    expect(result?.dictationStt).toBeUndefined();
    expect(result?.stt).toEqual({ apiKey: "voice-only" });
  });
});
