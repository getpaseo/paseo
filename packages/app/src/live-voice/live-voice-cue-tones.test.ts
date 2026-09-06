import { describe, expect, it } from "vitest";
import { encodePcm16Wav, parsePcm16Wav } from "@/utils/pcm16-wav";
import {
  LIVE_VOICE_CUES,
  LIVE_VOICE_CUE_PEAK_AMPLITUDE,
  LIVE_VOICE_CUE_SAMPLE_RATE,
  LIVE_VOICE_CUE_TONES,
  liveVoiceCueDurationMs,
  renderLiveVoiceCue,
  toPcm16,
} from "./live-voice-cue-tones";

describe("live voice cue tones", () => {
  it("keeps both cues short enough to be unobtrusive", () => {
    for (const cue of LIVE_VOICE_CUES) {
      const durationMs = liveVoiceCueDurationMs(cue);
      expect(durationMs).toBeGreaterThan(100);
      expect(durationMs).toBeLessThanOrEqual(300);
    }
  });

  it("mirrors the connect figure for disconnect so the two are distinguishable", () => {
    const rising = LIVE_VOICE_CUE_TONES.connected.map((tone) => tone.frequencyHz);
    const falling = LIVE_VOICE_CUE_TONES.disconnected.map((tone) => tone.frequencyHz);

    expect(rising[0]).toBeLessThan(rising[1]);
    expect(falling[0]).toBeGreaterThan(falling[1]);
    expect(falling.toReversed()).toEqual(rising);
  });

  it("renders envelopes that start and end at silence", () => {
    for (const cue of LIVE_VOICE_CUES) {
      const samples = renderLiveVoiceCue(cue);
      expect(samples.length).toBe(
        Math.ceil((liveVoiceCueDurationMs(cue) / 1000) * LIVE_VOICE_CUE_SAMPLE_RATE),
      );
      expect(samples[0]).toBe(0);
      // A non-zero final sample is an audible click on phone speakers.
      expect(Math.abs(samples[samples.length - 1] ?? 1)).toBeLessThan(0.005);

      const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      expect(peak).toBeGreaterThan(0.05);
      // Stays well under a speech-level signal so it cannot mask the assistant.
      expect(peak).toBeLessThanOrEqual(LIVE_VOICE_CUE_PEAK_AMPLITUDE * 2);
    }
  });

  it("survives a WAV round trip, which is how native plays it", () => {
    const samples = toPcm16(renderLiveVoiceCue("connected"));
    const bytes = encodePcm16Wav({ sampleRate: LIVE_VOICE_CUE_SAMPLE_RATE, samples });

    const parsed = parsePcm16Wav(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.sampleRate).toBe(LIVE_VOICE_CUE_SAMPLE_RATE);
    expect(Array.from(parsed?.samples ?? [])).toEqual(Array.from(samples));
  });
});
