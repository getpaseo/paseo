import { beforeEach, describe, expect, it, vi } from "vitest";

interface NativeListener {
  eventName: string;
  handler: (event: { data: unknown }) => void;
}

const nativeAudio = vi.hoisted(() => {
  const listeners: NativeListener[] = [];
  let resolveStop: (() => void) | null = null;
  return {
    listeners,
    initialize: vi.fn(async () => true),
    getMicrophonePermissionsAsync: vi.fn(async () => ({ granted: true })),
    requestMicrophonePermissionsAsync: vi.fn(async () => ({ granted: true })),
    toggleRecording: vi.fn((active: boolean) => active),
    stopRecording: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    ),
    resolveStop: () => {
      resolveStop?.();
      resolveStop = null;
    },
    releaseAudioSession: vi.fn(),
    addExpoTwoWayAudioEventListener: vi.fn(
      (eventName: string, handler: (event: { data: unknown }) => void) => {
        listeners.push({ eventName, handler });
        return { remove: vi.fn() };
      },
    ),
    resumePlayback: vi.fn(),
    playPCMData: vi.fn(),
    tearDown: vi.fn(),
    stopPlayback: vi.fn(),
  };
});

vi.mock("@getpaseo/expo-two-way-audio", () => nativeAudio);

import { createAudioEngine } from "./audio-engine.native";

function emitMicrophoneData(data: Uint8Array): void {
  const listener = nativeAudio.listeners.find(({ eventName }) => eventName === "onMicrophoneData");
  if (!listener) {
    throw new Error("Microphone listener was not registered");
  }
  listener.handler({ data });
}

describe("native audio capture", () => {
  beforeEach(() => {
    nativeAudio.listeners.length = 0;
    nativeAudio.resolveStop();
    vi.clearAllMocks();
  });

  it("drains microphone events queued while capture stops", async () => {
    const captured: Uint8Array[] = [];
    const engine = createAudioEngine({
      onCaptureData: (pcm) => captured.push(pcm),
      onVolumeLevel: vi.fn(),
    });

    await engine.startCapture();
    let didStop = false;
    const stopped = engine.stopCapture();
    void (async () => {
      await stopped;
      didStop = true;
    })();
    const finalPcm = new Uint8Array([1, 2, 3, 4]);
    emitMicrophoneData(finalPcm);

    await Promise.resolve();
    expect(nativeAudio.stopRecording).toHaveBeenCalledOnce();
    expect(didStop).toBe(false);

    nativeAudio.resolveStop();
    await stopped;

    expect(captured).toEqual([finalPcm]);

    emitMicrophoneData(new Uint8Array([5, 6]));
    expect(captured).toEqual([finalPcm]);
  });

  it("waits for capture to stop before destroying the native engine", async () => {
    const engine = createAudioEngine({
      onCaptureData: vi.fn(),
      onVolumeLevel: vi.fn(),
    });

    await engine.startCapture();
    const destroyed = engine.destroy();
    await Promise.resolve();

    expect(nativeAudio.tearDown).not.toHaveBeenCalled();

    nativeAudio.resolveStop();
    await destroyed;

    expect(nativeAudio.tearDown).toHaveBeenCalledOnce();
  });

  it("does not restart capture when destruction overtakes a pending stop", async () => {
    const engine = createAudioEngine({
      onCaptureData: vi.fn(),
      onVolumeLevel: vi.fn(),
    });

    await engine.startCapture();
    const stopped = engine.stopCapture();
    const restarted = engine.startCapture();
    const destroyed = engine.destroy();

    nativeAudio.resolveStop();
    await stopped;
    await expect(restarted).rejects.toThrow("Audio engine has been destroyed");
    await destroyed;

    expect(nativeAudio.toggleRecording).toHaveBeenCalledTimes(1);
  });
});
