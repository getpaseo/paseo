/**
 * The two Live Voice call cues, synthesized rather than sampled.
 *
 * Provenance: every sample here is generated from the tone table below — there
 * is no third-party audio in the app. Both platform players render from this
 * one spec (web fills an `AudioBuffer`, native writes a WAV to the cache), so
 * the connect and disconnect cues sound identical everywhere.
 *
 * The pair is deliberately a mirror: a rising two-note figure for connect and
 * the same two notes falling for disconnect. Mirrored intervals read as
 * "opened"/"closed" without either one needing to be loud, and a listener can
 * tell them apart without looking at the screen.
 */

export type LiveVoiceCue = "connected" | "disconnected";

export const LIVE_VOICE_CUES: readonly LiveVoiceCue[] = ["connected", "disconnected"];

export interface LiveVoiceCueTone {
  frequencyHz: number;
  startMs: number;
  durationMs: number;
}

export const LIVE_VOICE_CUE_SAMPLE_RATE = 24_000;

/**
 * Peak amplitude of a single tone, before the envelope. Low on purpose: the cue
 * plays over a live call, so it has to sit under speech rather than duck it.
 */
export const LIVE_VOICE_CUE_PEAK_AMPLITUDE = 0.16;

/** Linear fade-in. Anything shorter clicks on phone speakers. */
const ATTACK_MS = 6;

const D5_HZ = 587.33;
const A5_HZ = 880;

export const LIVE_VOICE_CUE_TONES: Record<LiveVoiceCue, readonly LiveVoiceCueTone[]> = {
  connected: [
    { frequencyHz: D5_HZ, startMs: 0, durationMs: 110 },
    { frequencyHz: A5_HZ, startMs: 85, durationMs: 165 },
  ],
  disconnected: [
    { frequencyHz: A5_HZ, startMs: 0, durationMs: 110 },
    { frequencyHz: D5_HZ, startMs: 85, durationMs: 185 },
  ],
};

/** Fade in, then decay exponentially to silence by the end of the tone. */
function envelopeAt(elapsedMs: number, durationMs: number): number {
  if (elapsedMs < 0 || elapsedMs >= durationMs) {
    return 0;
  }
  const attack = elapsedMs < ATTACK_MS ? elapsedMs / ATTACK_MS : 1;
  const progress = elapsedMs / durationMs;
  // `- progress` at the tail removes the step the raw exponential would leave.
  const decay = Math.exp(-4.5 * progress) - progress * Math.exp(-4.5);
  return attack * Math.max(0, decay);
}

export function liveVoiceCueDurationMs(cue: LiveVoiceCue): number {
  return LIVE_VOICE_CUE_TONES[cue].reduce(
    (longest, tone) => Math.max(longest, tone.startMs + tone.durationMs),
    0,
  );
}

/** Mono float samples in [-1, 1] at {@link LIVE_VOICE_CUE_SAMPLE_RATE}. */
export function renderLiveVoiceCue(cue: LiveVoiceCue): Float32Array<ArrayBuffer> {
  const durationMs = liveVoiceCueDurationMs(cue);
  const frames = Math.ceil((durationMs / 1000) * LIVE_VOICE_CUE_SAMPLE_RATE);
  const samples = new Float32Array(frames);

  for (const tone of LIVE_VOICE_CUE_TONES[cue]) {
    const startFrame = Math.round((tone.startMs / 1000) * LIVE_VOICE_CUE_SAMPLE_RATE);
    const toneFrames = Math.round((tone.durationMs / 1000) * LIVE_VOICE_CUE_SAMPLE_RATE);
    const step = (2 * Math.PI * tone.frequencyHz) / LIVE_VOICE_CUE_SAMPLE_RATE;
    for (let i = 0; i < toneFrames; i += 1) {
      const frame = startFrame + i;
      if (frame >= frames) {
        break;
      }
      const elapsedMs = (i / LIVE_VOICE_CUE_SAMPLE_RATE) * 1000;
      const gain = LIVE_VOICE_CUE_PEAK_AMPLITUDE * envelopeAt(elapsedMs, tone.durationMs);
      samples[frame] = (samples[frame] ?? 0) + Math.sin(step * i) * gain;
    }
  }

  // Overlapping tones can sum past unity; clamp instead of scaling so the two
  // cues keep the same absolute loudness.
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.max(-1, Math.min(1, samples[i] ?? 0));
  }
  return samples;
}

export function toPcm16(samples: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = Math.round(value * (value < 0 ? 0x8000 : 0x7fff));
  }
  return out;
}
