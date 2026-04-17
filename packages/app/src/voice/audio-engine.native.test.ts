import { describe, expect, it, vi } from "vitest";

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => null,
}));

import { createAudioEngine } from "@/voice/audio-engine.native";

describe("createAudioEngine native fallback", () => {
  it("does not crash boot when the native audio module is unavailable", async () => {
    const onError = vi.fn();
    const engine = createAudioEngine({
      onCaptureData() {},
      onVolumeLevel() {},
      onError,
    });

    await expect(engine.initialize()).rejects.toThrow(
      "Voice is unavailable on this device because the native audio module is not registered.",
    );
    await expect(engine.startCapture()).rejects.toThrow(
      "Voice is unavailable on this device because the native audio module is not registered.",
    );

    expect(engine.isMuted()).toBe(false);
    expect(engine.isPlaying()).toBe(false);
    engine.stop();
    engine.clearQueue();
    await expect(engine.destroy()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
