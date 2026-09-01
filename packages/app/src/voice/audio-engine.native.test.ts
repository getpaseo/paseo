import { describe, expect, it, vi } from "vitest";

import type { FakeNativeAudioModule } from "@/voice/test-utils/fake-native-audio-module";

const fakeRef = vi.hoisted(() => ({ current: null as FakeNativeAudioModule | null }));

vi.mock("@/voice/native-audio-module", async () => {
  const { createFakeNativeAudioModule } =
    await import("@/voice/test-utils/fake-native-audio-module");
  fakeRef.current = createFakeNativeAudioModule();
  return { loadNativeAudioModule: () => fakeRef.current!.native };
});

import { createAudioEngine } from "@/voice/audio-engine.native";

function createEngine() {
  return createAudioEngine({
    onCaptureData: () => undefined,
    onVolumeLevel: () => undefined,
  });
}

describe("native audio engine", () => {
  /**
   * Voice mode and dictation wrap the same native engine. Destroying the dictation wrapper used
   * to tear that engine down under voice mode, which then failed every later capture.
   */
  it("keeps capturing after another engine is destroyed", async () => {
    const state = fakeRef.current!.state;
    const voice = createEngine();
    await voice.initialize();
    await voice.startCapture();
    await voice.stopCapture();

    const dictation = createEngine();
    await dictation.initialize();
    await dictation.startCapture();
    await dictation.stopCapture();
    await dictation.destroy();

    await expect(voice.startCapture()).resolves.toBeUndefined();
    expect(state.recording).toBe(true);
    expect(state.tearDownCalls).toBe(0);

    await voice.destroy();
    expect(state.tearDownCalls).toBe(1);
    expect(state.engineExists).toBe(false);
  });
});
