import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "../../../persisted-config.js";
import { resolveOpenAiSpeechConfig } from "./config.js";

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
        dictationStt: { provider: "local", explicit: false },
        voiceStt: { provider: "local", explicit: false },
        voiceTts: { provider: "local", explicit: false },
      },
    });

    expect(resolved).toBeUndefined();
  });

  test("uses trimmed OPENAI_API_KEY when configured", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "  sk-test  ",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({
      env,
      persisted,
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
    });

    expect(resolved?.apiKey).toBe("sk-test");
    expect(resolved?.stt?.apiKey).toBe("sk-test");
    expect(resolved?.tts?.apiKey).toBe("sk-test");
  });

  test("uses nested voice config before env and non-voice fallbacks", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: {
        openai: {
          apiKey: "fallback-config-key",
          voice: {
            apiKey: "voice-config-key",
            baseUrl: " https://voice.example.com/v1 ",
          },
          baseUrl: "https://legacy-config.example.com/v1",
        },
      },
    });
    const env = {
      OPENAI_API_KEY: "env-key",
      OPENAI_VOICE_API_KEY: "voice-env-key",
      OPENAI_VOICE_BASE_URL: "https://voice-env.example.com/v1",
      OPENAI_BASE_URL: "https://env.example.com/v1",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({
      env,
      persisted,
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
    });

    expect(resolved?.apiKey).toBe("voice-config-key");
    expect(resolved?.baseUrl).toBe("https://voice.example.com/v1");
    expect(resolved?.stt?.apiKey).toBe("voice-config-key");
    expect(resolved?.stt?.baseUrl).toBe("https://voice.example.com/v1");
    expect(resolved?.tts?.apiKey).toBe("voice-config-key");
    expect(resolved?.tts?.baseUrl).toBe("https://voice.example.com/v1");
  });

  test("uses voice env config when nested voice config is unset", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "sk-test",
      OPENAI_VOICE_API_KEY: "voice-env-key",
      OPENAI_VOICE_BASE_URL: " https://voice-env.example.com/v1 ",
      OPENAI_BASE_URL: "https://env.example.com/v1",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({
      env,
      persisted,
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
    });

    expect(resolved?.apiKey).toBe("voice-env-key");
    expect(resolved?.stt?.apiKey).toBe("voice-env-key");
    expect(resolved?.tts?.apiKey).toBe("voice-env-key");
    expect(resolved?.baseUrl).toBe("https://voice-env.example.com/v1");
    expect(resolved?.stt?.baseUrl).toBe("https://voice-env.example.com/v1");
    expect(resolved?.tts?.baseUrl).toBe("https://voice-env.example.com/v1");
  });

  test("falls back to non-voice OpenAI config", () => {
    const persisted = PersistedConfigSchema.parse({
      providers: {
        openai: {
          apiKey: "fallback-config-key",
          baseUrl: " https://legacy-config.example.com/v1 ",
        },
      },
    });
    const env = {
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: " https://env.example.com/v1 ",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({
      env,
      persisted,
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
    });

    expect(resolved?.apiKey).toBe("fallback-config-key");
    expect(resolved?.baseUrl).toBe("https://legacy-config.example.com/v1");
  });

  test("falls back to global OpenAI env config when voice-specific inputs are unset", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: " https://env.example.com/v1 ",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({
      env,
      persisted,
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
    });

    expect(resolved?.apiKey).toBe("env-key");
    expect(resolved?.baseUrl).toBe("https://env.example.com/v1");
  });
});
