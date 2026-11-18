import { Buffer } from "buffer";

// Mirrors the daemon's default `PASEO_DICTATION_SILENCE_PEAK_THRESHOLD`
// (packages/server/src/server/dictation/dictation-stream-manager.ts). Audio whose
// peak stays below it is cleared by the daemon and never reaches speech-to-text.
// The `volume` level from the audio sources can't be used for this: native reports
// a dB curve and web a linear RMS, so the same input reads differently per platform.
export const DICTATION_SILENCE_PEAK_THRESHOLD = 300;

export function pcm16PeakFromBase64(base64Pcm: string): number {
  const bytes = Buffer.from(base64Pcm, "base64");
  let peak = 0;
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const sample = Math.abs(bytes.readInt16LE(offset));
    if (sample > peak) {
      peak = sample;
    }
  }
  return peak;
}

export function isAudiblePeak(peak: number): boolean {
  return peak >= DICTATION_SILENCE_PEAK_THRESHOLD;
}
