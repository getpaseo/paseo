import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** The first byte of every frame says which stream it belongs to. */
export const MediaOpcode = { Video: 0x01, Audio: 0x02, Keyframe: 0x03 } as const;

export type MediaFrame =
  | {
      opcode: typeof MediaOpcode.Video | typeof MediaOpcode.Keyframe;
      timestampMs: number;
      payload: Uint8Array;
    }
  | { opcode: typeof MediaOpcode.Audio; timestampMs: number; payload: Uint8Array };

const HEADER_BYTES = 1 + 8;

/** `[opcode u8][timestampMs f64][payload]` */
export function encodeMediaFrame(frame: MediaFrame): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + frame.payload.byteLength);
  bytes[0] = frame.opcode;
  new DataView(bytes.buffer).setFloat64(1, frame.timestampMs);
  bytes.set(frame.payload, HEADER_BYTES);
  return bytes;
}

/** Returns a view into `bytes`; the payload is not copied. */
export function decodeMediaFrame(bytes: Uint8Array): MediaFrame | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opcode = bytes[0];
  const timestampMs = view.getFloat64(1);
  const payload = bytes.subarray(HEADER_BYTES);
  if (opcode === MediaOpcode.Audio) return { opcode, timestampMs, payload };
  if (opcode === MediaOpcode.Video || opcode === MediaOpcode.Keyframe)
    return { opcode, timestampMs, payload };
  return null;
}

/** A video frame is `width * height` RGB pixels; audio is signed 16-bit mono PCM. */
export const VIDEO = { width: 16, height: 9, framesPerSecond: 15, keyframeInterval: 30 } as const;
export const AUDIO = { sampleRate: 8000, chunkMs: 20 } as const;

export const mediaStream = defineSubscription({
  name: "media.stream",
  input: z.object({ source: z.enum(["test-pattern"]) }),
  event: z.instanceof(Uint8Array),
});
