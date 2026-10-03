import { Buffer } from "buffer";
import type { AudioEngine } from "./audio-engine-types";

/** RPC-friendly file input. No browser Blob, URL, or platform knowledge is needed. */
export function createPlayAudio(engine: Pick<AudioEngine, "play">, signal: AbortSignal) {
  return async (source: { base64: string; mimeType: string }): Promise<void> => {
    if (signal.aborted) throw new Error("Playback stopped");
    if (
      !source ||
      typeof source.base64 !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(source.base64) ||
      source.base64.length % 4 !== 0 ||
      !source.base64.length
    ) {
      throw new Error("Audio must contain a non-empty base64-encoded file");
    }
    if (typeof source.mimeType !== "string" || !/^audio\/[\w.+-]+$/.test(source.mimeType)) {
      throw new Error("Audio must have an audio MIME type, such as audio/wav");
    }
    const bytes = Uint8Array.from(Buffer.from(source.base64, "base64"));
    await engine.play(
      {
        type: source.mimeType,
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer,
      },
      signal,
    );
  };
}
