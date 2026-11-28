import { AUDIO, VIDEO } from "../shared/media-frames";

export interface MediaSourceHandlers {
  video(pixels: Uint8Array, timestampMs: number, keyframe: boolean): void;
  audio(samples: Uint8Array, timestampMs: number): void;
}

/** A synthetic source: a moving gradient and a tone that rises and falls. */
export function openTestPattern(handlers: MediaSourceHandlers): { close(): void } {
  const started = Date.now();
  let frame = 0;
  let sample = 0;
  const video = setInterval(() => {
    const pixels = new Uint8Array(VIDEO.width * VIDEO.height * 3);
    for (let y = 0; y < VIDEO.height; y += 1)
      for (let x = 0; x < VIDEO.width; x += 1) {
        const offset = (y * VIDEO.width + x) * 3;
        pixels[offset] = ((x + frame) * 16) % 256;
        pixels[offset + 1] = (y * 28) % 256;
        pixels[offset + 2] = ((x + y + frame) * 8) % 256;
      }
    handlers.video(pixels, Date.now() - started, frame % VIDEO.keyframeInterval === 0);
    frame += 1;
  }, 1000 / VIDEO.framesPerSecond);
  const audio = setInterval(() => {
    const count = (AUDIO.sampleRate * AUDIO.chunkMs) / 1000;
    const samples = new Uint8Array(count * 2);
    const view = new DataView(samples.buffer);
    const amplitude = 8000 + 7000 * Math.sin((Date.now() - started) / 700);
    for (let index = 0; index < count; index += 1, sample += 1)
      view.setInt16(
        index * 2,
        amplitude * Math.sin((2 * Math.PI * 440 * sample) / AUDIO.sampleRate),
        true,
      );
    handlers.audio(samples, Date.now() - started);
  }, AUDIO.chunkMs);
  return {
    close() {
      clearInterval(video);
      clearInterval(audio);
    },
  };
}
