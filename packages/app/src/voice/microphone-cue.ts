import type { AudioPlaybackSource } from "./audio-engine-types";

/** Two descending notes mean muted; ascending notes mean listening again. */
export function createMicrophoneCue(muted: boolean): AudioPlaybackSource {
  const sampleRate = 24000;
  const noteSamples = Math.round(sampleRate * 0.085);
  const pcm = new Uint8Array(noteSamples * 2 * 2);
  const view = new DataView(pcm.buffer);
  const frequencies = muted ? [660, 440] : [440, 660];
  for (let note = 0; note < frequencies.length; note++) {
    for (let i = 0; i < noteSamples; i++) {
      const envelope = Math.sin((Math.PI * i) / noteSamples) ** 2;
      const sample = Math.sin((2 * Math.PI * frequencies[note] * i) / sampleRate);
      view.setInt16((note * noteSamples + i) * 2, Math.round(sample * envelope * 6500), true);
    }
  }
  return {
    size: pcm.byteLength,
    type: "audio/pcm;rate=24000;bits=16",
    async arrayBuffer() {
      return pcm.buffer;
    },
  };
}
