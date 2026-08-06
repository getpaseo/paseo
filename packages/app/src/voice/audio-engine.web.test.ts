// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAudioEngine } from "@/voice/audio-engine";

/**
 * A segment decodes across two awaits before it registers as the active
 * playback. A stop landing in that window has nothing to cancel, so without a
 * generation check the segment starts playing after the user asked for silence.
 */
const startedSources: string[] = [];

class FakeBufferSource {
  buffer: unknown = null;
  playbackRate = { value: 1 };
  connect = vi.fn();
  stop = vi.fn();
  addEventListener = vi.fn();
  start = vi.fn(() => {
    startedSources.push("started");
  });
}

/** Resolves only when the test says so, so a stop can land mid-decode. */
let releaseDecode: (() => void) | null = null;

class FakeAudioContext {
  state = "running";
  destination = {};
  sampleRate = 24000;
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createBufferSource = vi.fn(() => new FakeBufferSource());
  createGain = vi.fn(() => ({ connect: vi.fn(), gain: { value: 1 } }));
  createBuffer = vi.fn(() => ({
    duration: 1,
    getChannelData: () => new Float32Array(24000),
    copyToChannel: vi.fn(),
  }));
  decodeAudioData = vi.fn(
    () =>
      new Promise((resolve) => {
        releaseDecode = () =>
          resolve({ duration: 1, getChannelData: () => new Float32Array(24000) });
      }),
  );
}

beforeEach(() => {
  startedSources.length = 0;
  releaseDecode = null;
  // The engine reads `window.AudioContext`, not the bare global.
  vi.stubGlobal("AudioContext", FakeAudioContext);
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

/** Playback never invokes these — only capture does — but the type requires them. */
function playbackOnlyCallbacks() {
  return { onCaptureData: vi.fn(), onVolumeLevel: vi.fn() };
}

function mp3Segment() {
  return {
    size: 8,
    type: "audio/mpeg",
    async arrayBuffer() {
      return new ArrayBuffer(8);
    },
  };
}

describe("read-aloud playback cancellation", () => {
  it("drops a segment that finishes decoding after stop", async () => {
    const engine = createAudioEngine(playbackOnlyCallbacks());
    await engine.initialize();

    const playback = engine.play(mp3Segment()).catch(() => "rejected");
    // Let the queue reach decodeAudioData, which is now pending.
    await vi.waitFor(() => expect(releaseDecode).not.toBeNull());

    engine.stop();
    releaseDecode?.();
    await playback;

    // The decode completed, but the segment must never reach the output.
    expect(startedSources).toHaveLength(0);
  });

  it("drops a segment that finishes decoding after clearQueue", async () => {
    const engine = createAudioEngine(playbackOnlyCallbacks());
    await engine.initialize();

    const playback = engine.play(mp3Segment()).catch(() => "rejected");
    await vi.waitFor(() => expect(releaseDecode).not.toBeNull());

    engine.clearQueue();
    releaseDecode?.();
    await playback;

    expect(startedSources).toHaveLength(0);
  });
});
