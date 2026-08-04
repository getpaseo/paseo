// Not a browser global — the bundle has no `Buffer` unless it is imported, and
// `@types/node` makes the bare reference typecheck while failing at runtime.
import { Buffer } from "buffer";

import { createAudioEngine } from "@/voice/audio-engine";
import type { AudioEngine } from "@/voice/audio-engine-types";

/**
 * Read-aloud playback on web.
 *
 * Reuses the voice-mode audio engine because on web its `initialize()` only
 * opens a playback `AudioContext` — capture (and therefore the microphone
 * permission prompt) is behind the separate `startCapture()` call, which read
 * aloud never makes. `play()` already queues sequentially, which is exactly the
 * ordering read-aloud segments need.
 */
export const isReadAloudAudioSupported = true;

let engine: AudioEngine | null = null;

function getEngine(): AudioEngine {
  if (!engine) {
    engine = createAudioEngine(
      {
        onCaptureData: () => undefined,
        onVolumeLevel: () => undefined,
      },
      { traceLabel: "read-aloud" },
    );
  }
  return engine;
}

function toMimeType(format: string): string {
  if (format === "mp3") {
    return "audio/mpeg";
  }
  return format.startsWith("audio/") ? format : `audio/${format}`;
}

export async function playReadAloudSegment(params: {
  audioBase64: string;
  format: string;
  /**
   * Whether this segment has been superseded. Checked after `initialize()`:
   * a stop landing during that await is forgotten by the time `play()` runs,
   * because `play()` then captures the engine's post-stop generation and
   * proceeds as if it were a fresh request.
   */
  isCancelled?: () => boolean;
}): Promise<void> {
  const bytes = Buffer.from(params.audioBase64, "base64");
  const active = getEngine();
  await active.initialize();
  if (params.isCancelled?.()) {
    return;
  }
  await active.play({
    size: bytes.byteLength,
    type: toMimeType(params.format),
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  });
}

export function stopReadAloudAudio(): void {
  if (!engine) {
    return;
  }
  // Order matters: drain the queue first so `stop()` does not let a queued
  // segment start playing after the user asked for silence.
  engine.clearQueue();
  engine.stop();
}
