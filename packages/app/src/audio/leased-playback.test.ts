import { describe, expect, it, vi } from "vitest";
import { createAudioSessionLease } from "./audio-session-lease";
import { playAudioWithLease } from "./leased-playback";
import type { AudioEngine } from "@/voice/audio-engine-types";

function engine(): AudioEngine {
  return {
    initialize: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    startCapture: vi.fn(async () => undefined),
    stopCapture: vi.fn(async () => undefined),
    toggleMute: () => false,
    isMuted: () => false,
    play: vi.fn(async () => 1),
    stop: vi.fn(),
    clearQueue: vi.fn(),
    isPlaying: () => false,
  };
}
const audio = { type: "audio/pcm", size: 0, arrayBuffer: async () => new ArrayBuffer(0) };

describe("leased standalone playback", () => {
  it("refuses playback before touching an engine owned by another feature", async () => {
    const lease = createAudioSessionLease();
    const native = engine();
    lease.acquire("liveVoice");
    await expect(playAudioWithLease(native, audio, lease)).rejects.toThrow("already in use");
    expect(native.initialize).not.toHaveBeenCalled();
    expect(native.stop).not.toHaveBeenCalled();
  });

  it("holds the lease through playback and explicit cleanup", async () => {
    const lease = createAudioSessionLease();
    const native = engine();
    const done = Promise.withResolvers<number>();
    native.play = () => done.promise;
    native.stop = vi.fn(() => expect(lease.current()).toBe("playback"));
    const playing = playAudioWithLease(native, audio, lease);
    expect(lease.acquire("dictation")).toBeNull();
    done.resolve(1);
    expect(await playing).toBe(1);
    expect(native.stop).toHaveBeenCalledOnce();
    expect(lease.current()).toBeNull();
  });

  it("retains failed cleanup ownership and retries before the next playback", async () => {
    const lease = createAudioSessionLease();
    const native = engine();
    native.stop = vi.fn().mockImplementationOnce(() => {
      throw new Error("stop failed");
    });
    await expect(playAudioWithLease(native, audio, lease)).rejects.toThrow("stop failed");
    expect(lease.acquire("liveVoice")).toBeNull();
    await playAudioWithLease(native, audio, lease);
    expect(native.stop).toHaveBeenCalledTimes(3);
    expect(lease.current()).toBeNull();
  });
});
