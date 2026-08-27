import { describe, expect, it } from "vitest";

import { Pcm16MonoResampler, Pcm16ResamplerOutputLimitError } from "./pcm16-resampler.js";

function buildPcmBuffer(sampleCount: number, sampleValue = 1000): Buffer {
  const samples = new Int16Array(sampleCount);
  samples.fill(sampleValue);
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

describe("Pcm16MonoResampler", () => {
  it("resamples a normal upsampled client format within expected output bounds", () => {
    const resampler = new Pcm16MonoResampler({ inputRate: 8000, outputRate: 24000 });

    const outSamples = resampler.processChunk(buildPcmBuffer(1000)).length / 2;

    expect(outSamples).toBeGreaterThanOrEqual(2990);
    expect(outSamples).toBeLessThanOrEqual(3010);
  });

  it("keeps output bounded across consecutive chunks", () => {
    const resampler = new Pcm16MonoResampler({ inputRate: 8000, outputRate: 24000 });

    let outSamples = 0;
    for (let i = 0; i < 2; i += 1) {
      outSamples += resampler.processChunk(buildPcmBuffer(1000)).length / 2;
    }

    expect(outSamples).toBeGreaterThanOrEqual(5980);
    expect(outSamples).toBeLessThanOrEqual(6020);
  });

  it("downsamples high input rates without rejection", () => {
    const resampler = new Pcm16MonoResampler({ inputRate: 192000, outputRate: 16000 });

    const out = resampler.processChunk(buildPcmBuffer(1000));

    expect(out.length / 2).toBeLessThanOrEqual(1000);
    expect(out.length % 2).toBe(0);
  });

  it("rejects predicted output beyond the budget before allocating", () => {
    const resampler = new Pcm16MonoResampler({ inputRate: 1, outputRate: 24000 });

    let caught: unknown;
    try {
      resampler.processChunk(buildPcmBuffer(2048));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Pcm16ResamplerOutputLimitError);
    if (caught instanceof Pcm16ResamplerOutputLimitError) {
      expect(caught.maxSamples).toBe(2048 * 4 + 1024);
      expect(caught.predictedSamples).toBeGreaterThan(49_000_000);
      expect(caught.message).toContain("exceeds the 9216-sample output limit");
    }
  });
});
