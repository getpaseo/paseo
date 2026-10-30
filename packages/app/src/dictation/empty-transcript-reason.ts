import { isAudiblePeak } from "./pcm-level";

/**
 * Why a finished dictation produced no text.
 *
 * - `no-audio`: the microphone delivered no audio at all.
 * - `silent-audio`: audio arrived, but it never rose above the daemon's silence
 *   threshold, so the daemon dropped it before speech-to-text.
 * - `no-speech`: audible audio reached speech-to-text, which returned no words.
 */
export type DictationEmptyReason = "no-audio" | "silent-audio" | "no-speech";

export function resolveDictationEmptyReason(input: {
  segmentCount: number;
  peak: number;
}): DictationEmptyReason {
  if (input.segmentCount === 0) {
    return "no-audio";
  }
  if (!isAudiblePeak(input.peak)) {
    return "silent-audio";
  }
  return "no-speech";
}
