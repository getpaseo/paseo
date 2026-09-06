import { describe, expect, it, vi } from "vitest";
import { createAudioEngine, type NativeAudioModule } from "./audio-engine.native";

function createNativeModule() {
  const state = { initialized: false, recording: false, teardowns: 0, playbackStops: 0 };
  const native: NativeAudioModule = {
    async initialize() {
      state.initialized = true;
      return true;
    },
    tearDown() {
      state.initialized = false;
      state.recording = false;
      state.teardowns += 1;
    },
    toggleRecording(enabled) {
      if (!state.initialized) throw new Error("Native engine is not initialized");
      state.recording = enabled;
      return enabled;
    },
    releaseAudioSession() {},
    async getMicrophonePermissionsAsync() {
      return { granted: true };
    },
    async requestMicrophonePermissionsAsync() {
      return { granted: true };
    },
    addExpoTwoWayAudioEventListener() {
      return { remove() {} };
    },
    resumePlayback() {},
    playPCMData() {},
    stopPlayback() {
      state.playbackStops += 1;
    },
  };
  return { native, state };
}

function createWrapper(nativeModule: NativeAudioModule) {
  return createAudioEngine({ onCaptureData() {}, onVolumeLevel() {} }, { nativeModule });
}

describe("native audio engine shared binding", () => {
  it("pads the final standalone clip and stops native playback before releasing audio", async () => {
    vi.useFakeTimers();
    const { native, state } = createNativeModule();
    const voice = createWrapper(native);
    const submitted = Promise.withResolvers<void>();
    native.playPCMData = () => submitted.resolve();
    native.releaseAudioSession = vi.fn(() => expect(state.playbackStops).toBe(1));
    try {
      const playing = voice.play({
        size: 32000,
        type: "audio/pcm;rate=16000",
        arrayBuffer: async () => new ArrayBuffer(32000),
      });
      await submitted.promise;
      await vi.advanceTimersByTimeAsync(1000);
      expect(voice.isPlaying()).toBe(true);
      expect(native.releaseAudioSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      await playing;
      expect(native.releaseAudioSession).toHaveBeenCalledOnce();
    } finally {
      await voice.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps a single queue runner when playback is replaced immediately after stop", async () => {
    const { native } = createNativeModule();
    const voice = createWrapper(native);
    const submitted = Promise.withResolvers<void>();
    const samples: number[] = [];
    native.playPCMData = (pcm) => {
      samples.push(pcm[0]);
      submitted.resolve();
    };
    const play = (sample: number) =>
      voice
        .play({
          size: 32000,
          type: "audio/pcm;rate=16000",
          async arrayBuffer() {
            const pcm = new Uint8Array(32000);
            pcm[0] = sample;
            return pcm.buffer;
          },
        })
        .catch((error: unknown) => error);
    const first = play(1);
    await submitted.promise;
    voice.stop();
    voice.clearQueue();
    const second = play(2);
    const third = play(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(samples).toEqual([1, 2]);
    voice.stop();
    voice.clearQueue();
    await Promise.all([first, second, third]);
    await voice.destroy();
  });

  it.each(["decoding", "initialization"])(
    "does not submit playback stopped during %s",
    async (stage) => {
      const { native } = createNativeModule();
      const voice = createWrapper(native);
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      native.playPCMData = vi.fn();
      if (stage === "initialization") {
        native.initialize = async () => {
          entered.resolve();
          await pending.promise;
          return true;
        };
      }
      const playing = voice.play({
        size: 32000,
        type: "audio/pcm;rate=16000",
        async arrayBuffer() {
          if (stage === "decoding") {
            entered.resolve();
            await pending.promise;
          }
          return new ArrayBuffer(32000);
        },
      });
      const stopped = expect(playing).rejects.toThrow("Playback stopped");
      await entered.promise;
      voice.stop();
      pending.resolve();
      await stopped;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(native.playPCMData).not.toHaveBeenCalled();
      await voice.destroy();
    },
  );

  it("preserves recording when an idle wrapper is destroyed", async () => {
    const { native, state } = createNativeModule();
    const voice = createWrapper(native);
    const dictation = createWrapper(native);
    await voice.initialize();
    await dictation.startCapture();
    await voice.destroy();
    expect(state).toEqual({ initialized: true, recording: true, teardowns: 0, playbackStops: 0 });
    await dictation.destroy();
    expect(state).toEqual({ initialized: false, recording: false, teardowns: 1, playbackStops: 0 });
  });

  it("can capture again after the other wrapper is torn down", async () => {
    const { native, state } = createNativeModule();
    const voice = createWrapper(native);
    const dictation = createWrapper(native);
    await voice.startCapture();
    await voice.stopCapture();
    await dictation.startCapture();
    await dictation.destroy();
    await voice.startCapture();
    expect(state.recording).toBe(true);
    await voice.destroy();
    expect(state.teardowns).toBe(1);
  });

  it("does not stop another wrapper's playback", async () => {
    const { native, state } = createNativeModule();
    const voice = createWrapper(native);
    const dictation = createWrapper(native);
    const submitted = Promise.withResolvers<void>();
    native.playPCMData = () => submitted.resolve();
    const playing = voice.play({
      size: 32000,
      type: "audio/pcm;rate=16000",
      async arrayBuffer() {
        return new ArrayBuffer(32000);
      },
    });
    const stopped = expect(playing).rejects.toThrow("Playback stopped");
    await submitted.promise;
    await dictation.destroy();
    expect(state.playbackStops).toBe(0);
    voice.stop();
    await stopped;
    expect(state.playbackStops).toBe(1);
    await voice.destroy();
  });
});
