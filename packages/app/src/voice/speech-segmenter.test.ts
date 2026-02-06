import { describe, expect, it, vi } from "vitest";

import { SpeechSegmenter } from "./speech-segmenter";

const mkPcmBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 255;
  return bytes;
};

describe("SpeechSegmenter", () => {
  it("streams continuously and flushes at stop", () => {
    const onAudioSegment = vi.fn();
    const segmenter = new SpeechSegmenter(
      {
        enableContinuousStreaming: true,
        volumeThreshold: 0.3,
        silenceDurationMs: 2000,
        speechConfirmationMs: 300,
        detectionGracePeriodMs: 200,
        minChunkDurationMs: 100, // ensure we only flush on stop
        pcmSampleRate: 1000,
      },
      { onAudioSegment }
    );

    segmenter.pushPcmChunk(mkPcmBytes(50));
    segmenter.pushPcmChunk(mkPcmBytes(50));
    expect(onAudioSegment).not.toHaveBeenCalled();

    segmenter.stop(Date.now());

    expect(onAudioSegment).toHaveBeenCalledTimes(1);
    const lastCall = onAudioSegment.mock.calls.at(-1)![0];
    expect(lastCall.isLast).toBe(true);
    expect(lastCall.audioData.length).toBeGreaterThan(0);
  });

  it("detects speech, calls onSpeechStart, and flushes on speech end", () => {
    const onAudioSegment = vi.fn();
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const detectingChanges: boolean[] = [];
    const speakingChanges: boolean[] = [];

    const segmenter = new SpeechSegmenter(
      {
        enableContinuousStreaming: false,
        volumeThreshold: 0.3,
        silenceDurationMs: 2000,
        speechConfirmationMs: 300,
        detectionGracePeriodMs: 200,
        minChunkDurationMs: 100,
        pcmSampleRate: 1000,
      },
      {
        onAudioSegment,
        onSpeechStart,
        onSpeechEnd,
        onDetectingChange: (v) => detectingChanges.push(v),
        onSpeakingChange: (v) => speakingChanges.push(v),
      }
    );

    const t0 = 10_000;

    // Start detection.
    segmenter.pushVolumeLevel(0.5, t0);
    segmenter.pushPcmChunk(mkPcmBytes(50));
    expect(detectingChanges).toEqual([true]);
    expect(onSpeechStart).not.toHaveBeenCalled();

    // Confirm speech.
    segmenter.pushVolumeLevel(0.5, t0 + 300);
    segmenter.pushPcmChunk(mkPcmBytes(50));
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(speakingChanges).toEqual([true]);

    // End speech after silence.
    segmenter.pushVolumeLevel(0.0, t0 + 301);
    segmenter.pushPcmChunk(mkPcmBytes(50));
    segmenter.pushVolumeLevel(0.0, t0 + 301 + 2000);

    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
    expect(speakingChanges).toEqual([true, false]);
    expect(onAudioSegment).toHaveBeenCalled();
    const lastCall = onAudioSegment.mock.calls.at(-1)![0];
    expect(lastCall.isLast).toBe(true);
    expect(lastCall.audioData.length).toBeGreaterThan(0);
  });

  it("keeps detection alive across a brief pause and confirms short utterances", () => {
    const onSpeechStart = vi.fn();
    const detectingChanges: boolean[] = [];

    const segmenter = new SpeechSegmenter(
      {
        enableContinuousStreaming: false,
        volumeThreshold: 0.18,
        silenceDurationMs: 1400,
        speechConfirmationMs: 120,
        detectionGracePeriodMs: 700,
        minChunkDurationMs: 100,
        pcmSampleRate: 1000,
      },
      {
        onSpeechStart,
        onDetectingChange: (v) => detectingChanges.push(v),
      }
    );

    const t0 = 20_000;

    segmenter.pushVolumeLevel(0.4, t0);
    segmenter.pushPcmChunk(mkPcmBytes(20));
    segmenter.pushVolumeLevel(0.0, t0 + 80);
    segmenter.pushPcmChunk(mkPcmBytes(20));
    segmenter.pushVolumeLevel(0.4, t0 + 140);
    segmenter.pushPcmChunk(mkPcmBytes(20));

    expect(detectingChanges).toContain(true);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
  });
});
