import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as native from "@getpaseo/expo-two-way-audio";
import { createAudioEngine } from "./audio-engine.native";
import type { AudioPlaybackSource } from "./audio-engine-types";

const listeners: Record<string, Function> = {};

vi.mock("@getpaseo/expo-two-way-audio", () => ({
  initialize: vi.fn().mockResolvedValue(true),
  addExpoTwoWayAudioEventListener: vi.fn((event, cb) => {
    listeners[event] = cb;
    return {
      remove: vi.fn(() => {
        delete listeners[event];
      }),
    };
  }),
  playPCMData: vi.fn((pcm: Uint8Array) => {
    const durationSec = pcm.length / 2 / 16000;
    setTimeout(() => {
      if (listeners["onPlaybackComplete"]) {
        listeners["onPlaybackComplete"]();
      }
    }, durationSec * 1000);
  }),
  resumePlayback: vi.fn(),
  stopPlayback: vi.fn(),
  tearDown: vi.fn(),
}));

function source(arrayBuffer: () => Promise<ArrayBuffer>): AudioPlaybackSource {
  return { type: "audio/pcm;rate=16000", size: 32000, arrayBuffer };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) {
    delete listeners[key];
  }
});

afterEach(() => {
  vi.useRealTimers();
});

it("keeps canceled audio preparation from stealing the next clip's completion", async () => {
  const engine = createAudioEngine({ onCaptureData: vi.fn(), onVolumeLevel: vi.fn() });
  await engine.initialize();
  let finishPreparation!: (buffer: ArrayBuffer) => void;
  const preparing = vi.fn(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        finishPreparation = resolve;
      }),
  );
  const canceled = engine.play(source(preparing)).catch((error: Error) => error.message);
  await vi.waitFor(() => expect(preparing).toHaveBeenCalledOnce());
  engine.stop();
  engine.clearQueue();
  expect(await canceled).toBe("Playback stopped");

  const completed = vi.fn();
  const next = engine.play(source(async () => new ArrayBuffer(32000))).then(completed);
  await vi.waitFor(() => expect(native.playPCMData).toHaveBeenCalledOnce());
  finishPreparation(new ArrayBuffer(64000));
  await vi.advanceTimersByTimeAsync(2100);

  expect(completed).toHaveBeenCalledWith(1);
  expect(native.playPCMData).toHaveBeenCalledOnce();
  await next;
  await engine.destroy();
});

it("cancels before initialization completes and plays only the replacement", async () => {
  let finishInitialize!: (initialized: boolean) => void;
  vi.mocked(native.initialize).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishInitialize = resolve;
      }),
  );
  const engine = createAudioEngine({ onCaptureData: vi.fn(), onVolumeLevel: vi.fn() });
  const discardedSource = vi.fn(async () => new ArrayBuffer(32000));
  const canceled = engine.play(source(discardedSource)).catch((error: Error) => error.message);
  engine.stop();
  engine.clearQueue();
  expect(await canceled).toBe("Playback stopped");
  finishInitialize(true);

  const next = engine.play(source(async () => new ArrayBuffer(32000)));
  await vi.advanceTimersByTimeAsync(1100);
  expect(await next).toBe(1);
  expect(discardedSource).not.toHaveBeenCalled();
  expect(native.playPCMData).toHaveBeenCalledOnce();
  await engine.destroy();
});

it("ignores an old preparation failure while the replacement is playing", async () => {
  const engine = createAudioEngine({ onCaptureData: vi.fn(), onVolumeLevel: vi.fn() });
  let failPreparation!: (error: Error) => void;
  const preparing = vi.fn(
    () =>
      new Promise<ArrayBuffer>((_resolve, reject) => {
        failPreparation = reject;
      }),
  );
  const canceled = engine.play(source(preparing)).catch((error: Error) => error.message);
  await vi.waitFor(() => expect(preparing).toHaveBeenCalledOnce());
  engine.stop();
  engine.clearQueue();
  expect(await canceled).toBe("Playback stopped");

  const next = engine.play(source(async () => new ArrayBuffer(32000)));
  await vi.waitFor(() => expect(native.playPCMData).toHaveBeenCalledOnce());
  failPreparation(new Error("late decode error"));
  await vi.advanceTimersByTimeAsync(1100);
  expect(await next).toBe(1);
  await engine.destroy();
});
