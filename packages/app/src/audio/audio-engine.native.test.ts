import { beforeEach, expect, test, vi } from "vitest";

// Mirrors the iOS and Android modules: one engine per app, `initialize()` reuses it,
// `tearDown()` frees it, and `toggleRecording()` returns false once it is gone.
const native = vi.hoisted(() => {
  let engine: object | null = null;
  return {
    reset() {
      engine = null;
    },
    addExpoTwoWayAudioEventListener: () => ({ remove() {} }),
    getMicrophonePermissionsAsync: async () => ({ granted: true }),
    requestMicrophonePermissionsAsync: async () => ({ granted: true }),
    initialize: async () => {
      engine ??= {};
      return true;
    },
    tearDown: () => {
      engine = null;
    },
    toggleRecording: (value: boolean) => engine !== null && value,
    releaseAudioSession: () => {},
  };
});

vi.mock("@getpaseo/expo-two-way-audio", () => native);
vi.mock("expo-audio", () => ({ createAudioPlayer: vi.fn(), setAudioModeAsync: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: vi.fn(), Paths: {} }));

function callbacks() {
  return { onCaptureData: vi.fn(), onVolumeLevel: vi.fn(), onError: vi.fn() };
}

beforeEach(() => {
  native.reset();
  vi.resetModules();
});

test("voice capture starts after a dictation engine is destroyed", async () => {
  const { createAudioEngine } = await import("./audio-engine.native");
  const voiceCallbacks = callbacks();
  const voice = createAudioEngine(voiceCallbacks);
  await voice.initialize();

  const dictation = createAudioEngine(callbacks());
  await dictation.startCapture();
  await dictation.stopCapture();
  await dictation.destroy();

  await expect(voice.startCapture()).resolves.toBeUndefined();
  expect(voiceCallbacks.onError).not.toHaveBeenCalled();
});

test("destroying the last engine frees the native engine", async () => {
  const { createAudioEngine } = await import("./audio-engine.native");
  const voice = createAudioEngine(callbacks());
  await voice.startCapture();
  await voice.destroy();

  expect(native.toggleRecording(true)).toBe(false);
});
