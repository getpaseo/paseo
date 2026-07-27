import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "../persisted-config.js";
import { resolveSpeechConfig } from "./speech-config-resolver.js";

describe("resolveSpeechConfig", () => {
  test("resolves local-first defaults with voice features off", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {} as NodeJS.ProcessEnv;

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env,
      persisted,
    });

    expect(result.openai).toBeUndefined();
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    // No local model config until a voice feature is enabled (or modelsDir is set).
    expect(result.speech.local).toBeUndefined();
    expect(result.speech.sttLanguages).toEqual({
      dictation: "en",
      voice: "en",
    });
  });

  test("resolves feature-scoped local speech settings", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: { enabled: true },
        voiceMode: {
          enabled: true,
          turnDetection: { provider: "local" },
          stt: { provider: "openai", model: "gpt-4o-transcribe" },
        },
      },
      providers: {
        openai: { apiKey: "persisted-key" },
      },
    });
    const env = {
      PASEO_DICTATION_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
      PASEO_VOICE_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
      PASEO_VOICE_LOCAL_TTS_MODEL: "kokoro-en-v0_19",
      PASEO_VOICE_LOCAL_TTS_SPEAKER_ID: "5",
      PASEO_VOICE_LOCAL_TTS_SPEED: "1.35",
      PASEO_DICTATION_LANGUAGE: "es",
      PASEO_VOICE_LANGUAGE: "pt",
      PASEO_LOCAL_MODELS_DIR: "/tmp/models",
      OPENAI_API_KEY: "env-key",
      PASEO_VOICE_STT_PROVIDER: "openai",
      PASEO_DICTATION_STT_PROVIDER: "local",
      PASEO_VOICE_TTS_PROVIDER: "local",
    } as NodeJS.ProcessEnv;

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env,
      persisted,
    });

    expect(result.speech.local).toEqual({
      modelsDir: "/tmp/models",
      models: {
        dictationStt: "parakeet-tdt-0.6b-v2-int8",
        voiceStt: "parakeet-tdt-0.6b-v2-int8",
        voiceTts: "kokoro-en-v0_19",
        voiceTtsSpeakerId: 5,
        voiceTtsSpeed: 1.35,
      },
    });
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "openai",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceTts).toBe("kokoro-en-v0_19");
    expect(result.speech.local?.models.voiceTtsSpeakerId).toBe(5);
    expect(result.speech.local?.models.voiceTtsSpeed).toBe(1.35);
    expect(result.speech.sttLanguages).toEqual({
      dictation: "es",
      voice: "pt",
    });
    expect(result.openai?.stt?.apiKey).toBe("persisted-key");
    expect(result.openai?.tts?.apiKey).toBe("persisted-key");
    expect(result.openai?.stt?.model).toBe("gpt-4o-transcribe");
  });

  test("resolves STT language from env, settings, and voice-to-dictation fallback", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: {
          stt: {
            language: "fr",
          },
        },
        voiceMode: {
          stt: {
            language: "de",
          },
        },
      },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: {
        PASEO_DICTATION_LANGUAGE: "es",
        PASEO_VOICE_LANGUAGE: "  ",
      } as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.sttLanguages).toEqual({
      dictation: "es",
      voice: "es",
    });
  });

  test("respects disabled dictation and voice mode feature flags", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: { enabled: false },
        voiceMode: { enabled: false },
      },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: {} as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
  });

  test("enables providers when feature flags are explicitly on", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: { enabled: true },
        voiceMode: { enabled: true },
      },
    });

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env: {} as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.providers.dictationStt.enabled).toBe(true);
    expect(result.speech.providers.voiceTurnDetection.enabled).toBe(true);
    expect(result.speech.providers.voiceStt.enabled).toBe(true);
    expect(result.speech.providers.voiceTts.enabled).toBe(true);
  });
});
