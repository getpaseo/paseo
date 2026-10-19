import { describe, expect, it } from "vitest";
import type { LocalSpeechModel } from "@getpaseo/protocol/speech/rpc-schemas";
import {
  buildModelOptions,
  formatLanguages,
  formatModelSize,
  getLocalModelState,
  resolveSelectedModel,
  summarizeLocalModels,
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
  it("falls back to the catalog default when no local model is saved", () => {
    expect(
      resolveSelectedModel({
        kind: "stt",
        provider: "local",
        model: undefined,
        localModels: catalog,
      }),
    ).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(
      resolveSelectedModel({
        kind: "tts",
        provider: "openai",
        model: undefined,
        localModels: catalog,
      }),
    ).toBe("tts-1");
  });

  it("marks local models that still need a download", () => {
    expect(
      buildModelOptions({
        kind: "stt",
        provider: "local",
        selected: "parakeet-tdt-0.6b-v2-int8",
        localModels: catalog,
        notDownloadedLabel: (label) => `${label} (not downloaded)`,
      }),
    ).toEqual([
      { value: "parakeet-tdt-0.6b-v2-int8", label: "Parakeet v2" },
      { value: "parakeet-tdt-110m-en-int8", label: "Parakeet Small (not downloaded)" },
    ]);
  });

  it("keeps a custom OpenAI-compatible model id selectable", () => {
    const options = buildModelOptions({
      kind: "stt",
      provider: "openai",
      selected: "my-whisper",
      localModels: catalog,
      notDownloadedLabel: (label) => label,
    });
    expect(options.at(-1)).toEqual({ value: "my-whisper", label: "my-whisper" });
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

  it("summarizes each local provider by its downloads", () => {
    expect(summarizeLocalModels(catalog, "stt")).toEqual({ kind: "downloaded", count: 1 });
    expect(summarizeLocalModels(catalog, "tts")).toEqual({ kind: "downloaded", count: 1 });
    const downloading = [
      ...catalog,
      model({
        id: "parakeet-tdt-0.6b-v3-int8",
        status: "downloading",
        receivedBytes: 1,
        totalBytes: 4,
      }),
    ];
    expect(summarizeLocalModels(downloading, "stt")).toEqual({ kind: "downloading", percent: 25 });
    expect(summarizeLocalModels(downloading, "tts")).toEqual({ kind: "downloaded", count: 1 });
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
