import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import { resolveDictationEmptyReason } from "@/dictation/empty-transcript-reason";
import {
  DICTATION_SILENCE_PEAK_THRESHOLD,
  isAudiblePeak,
  pcm16PeakFromBase64,
} from "@/dictation/pcm-level";

function pcm16Base64(samples: number[]): string {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes.toString("base64");
}

describe("pcm16PeakFromBase64", () => {
  it("returns the largest absolute sample, including negative ones", () => {
    expect(pcm16PeakFromBase64(pcm16Base64([0, 120, -4000, 2500]))).toBe(4000);
  });

  it("reads digital silence as zero", () => {
    expect(pcm16PeakFromBase64(pcm16Base64([0, 0, 0, 0]))).toBe(0);
  });

  it("ignores a trailing odd byte", () => {
    const bytes = Buffer.concat([Buffer.from(pcm16Base64([-700]), "base64"), Buffer.from([0x7f])]);
    expect(pcm16PeakFromBase64(bytes.toString("base64"))).toBe(700);
  });
});

describe("isAudiblePeak", () => {
  it("uses the daemon's default silence threshold", () => {
    expect(isAudiblePeak(DICTATION_SILENCE_PEAK_THRESHOLD - 1)).toBe(false);
    expect(isAudiblePeak(DICTATION_SILENCE_PEAK_THRESHOLD)).toBe(true);
  });
});

describe("resolveDictationEmptyReason", () => {
  it("reports missing audio when the microphone delivered nothing", () => {
    expect(resolveDictationEmptyReason({ segmentCount: 0, peak: 0 })).toBe("no-audio");
  });

  it("reports silent audio when nothing crossed the silence threshold", () => {
    expect(resolveDictationEmptyReason({ segmentCount: 40, peak: 120 })).toBe("silent-audio");
  });

  it("reports no recognized speech when audible audio produced no text", () => {
    expect(resolveDictationEmptyReason({ segmentCount: 40, peak: 9000 })).toBe("no-speech");
  });
});
