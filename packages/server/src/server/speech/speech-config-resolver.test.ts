import path from "node:path";

import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "../persisted-config.js";
import { resolveSpeechConfig } from "./speech-config-resolver.js";

describe("resolveSpeechConfig", () => {
  test("resolves local-first defaults without env overrides", () => {
    const paseoHome = "/tmp/paseo-home";
    const persisted = PersistedConfigSchema.parse({});
    const env = {} as NodeJS.ProcessEnv;

    const result = resolveSpeechConfig({
      paseoHome,
      env,
      persisted,
    });

    expect(result.openai).toBeUndefined();
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.providers.voiceTurnDetection.enabled).toBe(false);
    expect(result.speech.providers.voiceStt.enabled).toBe(false);
    expect(result.speech.providers.voiceTts.enabled).toBe(false);
    expect(result.speech.local).toEqual({
      modelsDir: path.join(paseoHome, "models", "local-speech"),
      models: {
        dictationStt: "parakeet-tdt-0.6b-v2-int8",
        voiceStt: "parakeet-tdt-0.6b-v2-int8",
        voiceTts: "kokoro-en-v0_19",
        voiceTtsSpeakerId: 0,
      },
    });
    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.sttLanguages).toEqual({
      dictation: "en",
      voice: "en",
    });
  });

  test("resolves dictation settings without reading manual voice configuration", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: { stt: { provider: "local", language: "fr" } },
      },
    });
    const env = {
      PASEO_DICTATION_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
      PASEO_DICTATION_LANGUAGE: "es",
      PASEO_LOCAL_MODELS_DIR: "/tmp/models",
      PASEO_DICTATION_STT_PROVIDER: "local",
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
        voiceTtsSpeakerId: 0,
      },
    });
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceStt.enabled).toBe(false);
    expect(result.speech.providers.voiceTurnDetection.enabled).toBe(false);
    expect(result.speech.providers.voiceTts.enabled).toBe(false);
    expect(result.speech.sttLanguages).toEqual({
      dictation: "es",
      voice: "es",
    });
  });

  test("respects disabled dictation", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: { enabled: false },
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
    expect(result.speech.providers.voiceTurnDetection.enabled).toBe(false);
    expect(result.speech.providers.voiceStt.enabled).toBe(false);
    expect(result.speech.providers.voiceTts.enabled).toBe(false);
  });
});
