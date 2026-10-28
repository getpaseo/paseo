import { describe, expect, it } from "vitest";
import type { LocalSpeechModel } from "@getpaseo/protocol/speech/rpc-schemas";
import {
  buildOpenAiModelOptions,
  getSpeechSite,
  formatLanguages,
  formatModelSize,
  getLocalModelState,
  summarizeSpeechSite,
} from "./voice-settings";

function model(overrides: Partial<LocalSpeechModel>): LocalSpeechModel {
  return {
    id: "parakeet-tdt-0.6b-v2-int8",
    kind: "stt",
    label: "Parakeet v2",
    description: "Accurate English transcription.",
    languages: ["en"],
    downloadSizeBytes: 482_468_385,
    isDefault: true,
    inUse: true,
    status: "installed",
    ...overrides,
  };
}

const catalog = [
  model({}),
  model({
    id: "parakeet-tdt-110m-en-int8",
    label: "Parakeet Small",
    isDefault: false,
    status: "not_installed",
    inUse: false,
  }),
  model({ id: "kokoro-en-v0_19", kind: "tts", label: "Kokoro", inUse: false }),
];

describe("voice settings", () => {
  it("keeps local STT language from the wire when opening a provider sheet", () => {
    const features = {
      dictation: { enabled: true, stt: { provider: "local", language: "fr" } },
      voiceMode: {
        enabled: false,
        stt: { provider: "local", language: "de" },
        tts: { provider: "local" },
      },
    };
    expect(getSpeechSite(features, "dictation.stt")).toMatchObject({
      provider: "local",
      language: "fr",
    });
    expect(getSpeechSite(features, "voiceMode.stt")).toMatchObject({
      provider: "local",
      language: "de",
    });
  });

  it("summarizes a local site by its model, falling back to the catalog default", () => {
    const summary = (modelId?: string) =>
      summarizeSpeechSite({
        siteId: "dictation.stt",
        site: { provider: "local", model: modelId },
        envOverrides: {},
        localModels: catalog,
      });
    expect(summary()).toEqual({ kind: "local", model: "Parakeet v2" });
    expect(summary("parakeet-tdt-110m-en-int8")).toEqual({
      kind: "local",
      model: "Parakeet Small",
    });
  });

  it("flags an OpenAI site with no saved key and no env key", () => {
    const summary = (envOverrides: Record<string, string>) =>
      summarizeSpeechSite({
        siteId: "voiceMode.tts",
        site: { provider: "openai", hasApiKey: false },
        envOverrides,
        localModels: catalog,
      });
    expect(summary({})).toEqual({ kind: "openai", model: "tts-1", missingKey: true });
    expect(summary({ "features.voiceMode.tts.apiKey": "OPENAI_API_KEY" })).toEqual({
      kind: "openai",
      model: "tts-1",
      missingKey: false,
    });
  });

  it("keeps a custom OpenAI-compatible model id selectable", () => {
    expect(buildOpenAiModelOptions("stt", "my-whisper").at(-1)).toEqual({
      value: "my-whisper",
      label: "my-whisper",
    });
  });

  it("reports download progress as a percentage", () => {
    expect(
      getLocalModelState(model({ status: "downloading", receivedBytes: 241, totalBytes: 482 })),
    ).toEqual({ kind: "downloading", percent: 50 });
    expect(getLocalModelState(model({ status: "downloading" }))).toEqual({
      kind: "downloading",
      percent: null,
    });
  });

  it("formats download sizes", () => {
    expect(formatModelSize(482_468_385)).toBe("482 MB");
    expect(formatModelSize(1_250_000_000)).toBe("1.3 GB");
  });

  it("names a short language list and counts the rest of a long one", () => {
    const formatMore = (languages: string, count: number) => `${languages} and ${count} more`;
    expect(formatLanguages({ languages: ["en", "de"], locale: "en", formatMore })).toBe(
      "English, German",
    );
    const whisper = ["en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca"];
    expect(formatLanguages({ languages: whisper, locale: "en", formatMore })).toBe(
      "English, Chinese, German, Spanish, Russian, Korean, French, Japanese, Portuguese, Turkish and 2 more",
    );
  });
});
