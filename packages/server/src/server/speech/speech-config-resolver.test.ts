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
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "local",
      explicit: false,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: false,
    });
    expect(result.speech.local).toEqual({
      modelsDir: path.join(paseoHome, "models", "local-speech"),
      autoDownload: true,
      models: {
        dictationStt: "parakeet-tdt-0.6b-v2-int8",
        voiceStt: "parakeet-tdt-0.6b-v2-int8",
        voiceTts: "pocket-tts-onnx-int8",
      },
    });
    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceTts).toBe("pocket-tts-onnx-int8");
  });

  test("resolves feature-scoped local model env vars", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        voiceMode: {
          stt: { provider: "openai", model: "gpt-4o-transcribe" },
        },
      },
      providers: {
        openai: { apiKey: "persisted-key" },
      },
    });
    const env = {
      PASEO_DICTATION_LOCAL_STT_MODEL: "zipformer",
      PASEO_VOICE_LOCAL_STT_MODEL: "parakeet",
      PASEO_VOICE_LOCAL_TTS_MODEL: "kitten",
      PASEO_VOICE_LOCAL_TTS_SPEAKER_ID: "5",
      PASEO_VOICE_LOCAL_TTS_SPEED: "1.35",
      PASEO_LOCAL_MODELS_DIR: "/tmp/models",
      PASEO_LOCAL_AUTO_DOWNLOAD: "0",
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
      autoDownload: false,
      models: {
        dictationStt: "zipformer-bilingual-zh-en-2023-02-20",
        voiceStt: "parakeet-tdt-0.6b-v3-int8",
        voiceTts: "kitten-nano-en-v0_1-fp16",
        voiceTtsSpeakerId: 5,
        voiceTtsSpeed: 1.35,
      },
    });
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: true,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "openai",
      explicit: true,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: true,
    });
    expect(result.speech.local?.models.dictationStt).toBe("zipformer-bilingual-zh-en-2023-02-20");
    expect(result.speech.local?.models.voiceStt).toBe("parakeet-tdt-0.6b-v3-int8");
    expect(result.speech.local?.models.voiceTts).toBe("kitten-nano-en-v0_1-fp16");
    expect(result.speech.local?.models.voiceTtsSpeakerId).toBe(5);
    expect(result.speech.local?.models.voiceTtsSpeed).toBe(1.35);
    expect(result.openai?.apiKey).toBe("env-key");
    expect(result.openai?.stt?.model).toBe("gpt-4o-transcribe");
  });

  test("ignores deprecated shared local model env vars", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      PASEO_LOCAL_STT_MODEL: "zipformer-bilingual-zh-en-2023-02-20",
      PASEO_LOCAL_TTS_MODEL: "kitten-nano-en-v0_1-fp16",
    } as NodeJS.ProcessEnv;

    const result = resolveSpeechConfig({
      paseoHome: "/tmp/paseo-home",
      env,
      persisted,
    });

    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceTts).toBe("pocket-tts-onnx-int8");
  });
});
