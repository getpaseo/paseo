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

describe("resolveOpenAiSpeechConfig", () => {
  test("treats empty OPENAI_API_KEY as unset", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({
      env,
      persisted,
      providers: {
        ...ALL_OPENAI,
        dictationStt: { provider: "local", explicit: false },
        voiceStt: { provider: "local", explicit: false },
        voiceTts: { provider: "local", explicit: false },
      },
    });

    expect(resolved).toBeUndefined();
  });

  test("applies trimmed OPENAI_API_KEY to both STT and TTS", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "  sk-test  ",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({ env, persisted, providers: ALL_OPENAI });

    expect(resolved?.stt?.apiKey).toBe("sk-test");
    expect(resolved?.tts?.apiKey).toBe("sk-test");
  });

  test("resolves distinct endpoints for STT and TTS", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: {
        openai: {
          stt: {
            apiKey: "stt-key",
            baseUrl: " https://stt.example.com/v1 ",
          },
          tts: {
            apiKey: "tts-key",
            baseUrl: " https://tts.example.com/v1 ",
          },
        },
      },
    });

    const resolved = resolveOpenAiSpeechConfig({
      env: {} as NodeJS.ProcessEnv,
      persisted,
      providers: ALL_OPENAI,
    });

    expect(resolved?.stt?.apiKey).toBe("stt-key");
    expect(resolved?.stt?.baseUrl).toBe("https://stt.example.com/v1");
    expect(resolved?.tts?.apiKey).toBe("tts-key");
    expect(resolved?.tts?.baseUrl).toBe("https://tts.example.com/v1");
  });

  test("prefers nested STT/TTS config over env and global fallbacks", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: {
        openai: {
          apiKey: "fallback-config-key",
          baseUrl: "https://global-config.example.com/v1",
          stt: { apiKey: "stt-config-key", baseUrl: " https://stt.example.com/v1 " },
          tts: { apiKey: "tts-config-key", baseUrl: " https://tts.example.com/v1 " },
        },
      },
    });
    const env = {
      OPENAI_API_KEY: "env-key",
      OPENAI_STT_API_KEY: "stt-env-key",
      OPENAI_STT_BASE_URL: "https://stt-env.example.com/v1",
      OPENAI_TTS_API_KEY: "tts-env-key",
      OPENAI_TTS_BASE_URL: "https://tts-env.example.com/v1",
      OPENAI_BASE_URL: "https://env.example.com/v1",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({ env, persisted, providers: ALL_OPENAI });

    expect(resolved?.stt?.apiKey).toBe("stt-config-key");
    expect(resolved?.stt?.baseUrl).toBe("https://stt.example.com/v1");
    expect(resolved?.tts?.apiKey).toBe("tts-config-key");
    expect(resolved?.tts?.baseUrl).toBe("https://tts.example.com/v1");
  });

  test("uses STT/TTS env config when nested config is unset", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "sk-test",
      OPENAI_STT_API_KEY: "stt-env-key",
      OPENAI_STT_BASE_URL: " https://stt-env.example.com/v1 ",
      OPENAI_TTS_API_KEY: "tts-env-key",
      OPENAI_TTS_BASE_URL: " https://tts-env.example.com/v1 ",
      OPENAI_BASE_URL: "https://env.example.com/v1",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({ env, persisted, providers: ALL_OPENAI });

    expect(resolved?.stt?.apiKey).toBe("stt-env-key");
    expect(resolved?.stt?.baseUrl).toBe("https://stt-env.example.com/v1");
    expect(resolved?.tts?.apiKey).toBe("tts-env-key");
    expect(resolved?.tts?.baseUrl).toBe("https://tts-env.example.com/v1");
  });

  test("falls back to global OpenAI config for both STT and TTS", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: {
        openai: {
          apiKey: "fallback-config-key",
          baseUrl: " https://global-config.example.com/v1 ",
        },
      },
    });
    const env = {} as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({ env, persisted, providers: ALL_OPENAI });

    expect(resolved?.stt?.apiKey).toBe("fallback-config-key");
    expect(resolved?.stt?.baseUrl).toBe("https://global-config.example.com/v1");
    expect(resolved?.tts?.apiKey).toBe("fallback-config-key");
    expect(resolved?.tts?.baseUrl).toBe("https://global-config.example.com/v1");
  });

  test("falls back to global OpenAI env config when feature inputs are unset", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: " https://env.example.com/v1 ",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({ env, persisted, providers: ALL_OPENAI });

    expect(resolved?.stt?.apiKey).toBe("env-key");
    expect(resolved?.stt?.baseUrl).toBe("https://env.example.com/v1");
    expect(resolved?.tts?.apiKey).toBe("env-key");
    expect(resolved?.tts?.baseUrl).toBe("https://env.example.com/v1");
  });

  test("ignores empty endpoint env vars and falls back to OPENAI_API_KEY", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "global-key",
      OPENAI_STT_API_KEY: "",
      OPENAI_STT_BASE_URL: "  ",
      OPENAI_TTS_API_KEY: "",
      OPENAI_TTS_BASE_URL: "",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({ env, persisted, providers: ALL_OPENAI });

    expect(resolved?.stt?.apiKey).toBe("global-key");
    expect(resolved?.tts?.apiKey).toBe("global-key");
  });

  test("omits TTS when only an STT key is configured", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: {
        openai: {
          stt: { apiKey: "stt-only-key" },
        },
      },
    });

    const resolved = resolveOpenAiSpeechConfig({
      env: {} as NodeJS.ProcessEnv,
      persisted,
      providers: ALL_OPENAI,
    });

    expect(resolved?.stt?.apiKey).toBe("stt-only-key");
    expect(resolved?.tts).toBeUndefined();
  });

  test("resolves STT even when an unused TTS env var is invalid", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: {
        openai: {
          stt: { apiKey: "stt-only-key" },
        },
      },
    });
    const env = { TTS_VOICE: "not-a-real-voice", TTS_MODEL: "bogus-model" } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({ env, persisted, providers: ALL_OPENAI });

    expect(resolved?.stt?.apiKey).toBe("stt-only-key");
    expect(resolved?.tts).toBeUndefined();
  });
});
