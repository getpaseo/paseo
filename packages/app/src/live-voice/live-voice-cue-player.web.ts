/**
 * Web/Electron Live Voice cue playback.
 *
 * Web Audio rather than an `<audio>` element: the samples are synthesized in
 * `live-voice-cue-tones`, so there is nothing to fetch, and a `AudioBufferSource`
 * mixes with the WebRTC `<audio>` element carrying the assistant's speech
 * instead of competing with it for the element's playback state.
 *
 * The context is created on the first cue, which always follows the click that
 * started the call, so autoplay policy has already been satisfied.
 */

import {
  LIVE_VOICE_CUE_SAMPLE_RATE,
  renderLiveVoiceCue,
  type LiveVoiceCue,
} from "@/live-voice/live-voice-cue-tones";
import type { LiveVoiceCuePlayer } from "@/live-voice/live-voice-cue-player";

export type { LiveVoiceCue } from "@/live-voice/live-voice-cue-tones";
export type { LiveVoiceCuePlayer } from "@/live-voice/live-voice-cue-player";

export function createLiveVoiceCuePlayer(): LiveVoiceCuePlayer {
  const buffers = new Map<LiveVoiceCue, AudioBuffer>();
  let context: AudioContext | null = null;
  let disposed = false;

  function getContext(): AudioContext | null {
    if (disposed || typeof AudioContext === "undefined") {
      return null;
    }
    if (!context) {
      context = new AudioContext({ sampleRate: LIVE_VOICE_CUE_SAMPLE_RATE });
    }
    if (context.state === "suspended") {
      // Best effort: a still-suspended context just drops the cue silently.
      void context.resume().catch(() => undefined);
    }
    return context;
  }

  function getBuffer(target: AudioContext, cue: LiveVoiceCue): AudioBuffer {
    const cached = buffers.get(cue);
    if (cached) {
      return cached;
    }
    const samples = renderLiveVoiceCue(cue);
    const buffer = target.createBuffer(1, samples.length, LIVE_VOICE_CUE_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    buffers.set(cue, buffer);
    return buffer;
  }

  return {
    play(cue) {
      try {
        const target = getContext();
        if (!target) {
          return;
        }
        const source = target.createBufferSource();
        source.buffer = getBuffer(target, cue);
        source.connect(target.destination);
        source.start();
      } catch {
        // A cue is never worth failing a call over.
      }
    },

    dispose() {
      disposed = true;
      buffers.clear();
      const target = context;
      context = null;
      void target?.close().catch(() => undefined);
    },
  };
}
