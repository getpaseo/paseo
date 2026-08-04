/**
 * Read-aloud playback, native fallback.
 *
 * The daemon streams raw PCM segments that the web build decodes through the
 * voice `AudioEngine`. Native has no equivalent decode-and-queue path yet, so
 * playback is unimplemented and the footer button hides rather than showing a
 * control that makes no sound. The real implementation lives in
 * `read-aloud-audio.web.ts`.
 */
export const isReadAloudAudioSupported = false;

export async function playReadAloudSegment(_params: {
  audioBase64: string;
  format: string;
  isCancelled?: () => boolean;
}): Promise<void> {
  throw new Error("Read aloud is not supported on this platform");
}

export function stopReadAloudAudio(): void {
  // No playback to stop.
}
