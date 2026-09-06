import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { SpeechModelManager } from "./speech-model-manager.js";

describe("SpeechModelManager", () => {
  const fakeLogger = {
    child: () => fakeLogger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
  } as any;

  it("lists catalog speech models with their initial metadata and structure", async () => {
    const manager = new SpeechModelManager("/tmp/test-models", fakeLogger);
    expect(manager.getModelsDir()).toBe("/tmp/test-models");

    const models = await manager.listModels();
    expect(models.length).toBe(4);

    const whisperLarge = models.find((m) => m.id === "whisper-large-v3-turbo-int8");
    expect(whisperLarge).toBeDefined();
    expect(whisperLarge?.kind).toBe("stt");
    expect(whisperLarge?.sizeMB).toBe(538);
    expect(whisperLarge?.languages).toContain("multi");

    const sensevoice = models.find((m) => m.id === "sensevoice-small-int8");
    expect(sensevoice).toBeUndefined();

    const moonshine = models.find((m) => m.id === "moonshine-base-en-int8");
    expect(moonshine).toBeUndefined();

    const parakeetV2 = models.find((m) => m.id === "parakeet-tdt-0.6b-v2-int8");
    expect(parakeetV2).toBeUndefined();

    const parakeetV3 = models.find((m) => m.id === "parakeet-tdt-0.6b-v3-int8");
    expect(parakeetV3).toBeDefined();
    expect(parakeetV3?.kind).toBe("stt");
    expect(parakeetV3?.sizeMB).toBe(465);
    expect(parakeetV3?.languages).toContain("pt");
    expect(parakeetV3?.runtimeSupported).toBe(true);
    expect(parakeetV3?.isDefault).toBe(true);

    const kokoroEn = models.find((m) => m.id === "kokoro-en-v0_19");
    expect(kokoroEn).toBeUndefined();

    const kokoroMulti = models.find((m) => m.id === "kokoro-multi-v1_0");
    expect(kokoroMulti).toBeDefined();
    expect(kokoroMulti?.kind).toBe("tts");
    expect(kokoroMulti?.languages).toContain("pt-BR");
    expect(kokoroMulti?.runtimeSupported).toBe(true);
    expect(kokoroMulti?.isDefault).toBe(true);

    const silero = models.find((m) => m.id === "silero-vad");
    expect(silero).toBeDefined();
    expect(silero?.kind).toBe("vad");
    expect(silero?.status).toBe("installed");
  });

  it("throws an error when attempting to delete a non-existent or bundled model", async () => {
    const manager = new SpeechModelManager("/tmp/test-models", fakeLogger);
    await expect(manager.deleteModel("non-existent-model")).rejects.toThrow("Unknown speech model ID");
    await expect(manager.deleteModel("silero-vad")).rejects.toThrow("Cannot delete bundled model");
  });
});
