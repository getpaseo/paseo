/**
 * Read-aloud playback, native fallback.
 *
 * Read aloud is driven by a text selection, and native has no JS-reachable
 * selection API for `<Text selectable>` — iOS hands selection to the system edit
 * menu, Android to an ActionMode, and neither is reachable without a native
 * module. So there is no entry point for it on native and playback is a no-op.
 * The real implementation lives in `read-aloud-audio.web.ts`.
 */
export const isReadAloudAudioSupported = false;

export async function playReadAloudSegment(_params: {
  audioBase64: string;
  format: string;
}): Promise<void> {
  throw new Error("Read aloud is not supported on this platform");
}

export function setReadAloudPlaybackRate(_rate: number): void {
  // No playback to speed up.
}

export function stopReadAloudAudio(): void {
  // No playback to stop.
}
