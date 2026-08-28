import { z } from "zod";
import { asUint8Array } from "./terminal.js";

export const BrowserScreencastOpcode = {
  Frame: 0x20,
} as const;

export type BrowserScreencastOpcode =
  (typeof BrowserScreencastOpcode)[keyof typeof BrowserScreencastOpcode];

/**
 * The captured JPEG is not the guest viewport size: CDP scales it to fit
 * maxWidth/maxHeight, so a 1280x800 guest can arrive as 1194x800. Viewers map
 * pointer coordinates through these dimensions, not the image's own.
 */
export const BrowserScreencastMetadataSchema = z.object({
  deviceWidth: z.number().positive(),
  deviceHeight: z.number().positive(),
});

export type BrowserScreencastMetadata = z.infer<typeof BrowserScreencastMetadataSchema>;

export interface BrowserScreencastFrame {
  opcode: typeof BrowserScreencastOpcode.Frame;
  slot: number;
  metadata: BrowserScreencastMetadata;
  payload: Uint8Array;
}

export function encodeBrowserScreencastFrame(input: {
  slot: number;
  metadata: BrowserScreencastMetadata;
  payload: Uint8Array | ArrayBuffer | string;
}): Uint8Array {
  const payload = asUint8Array(input.payload) ?? new Uint8Array();
  const metadata = new TextEncoder().encode(JSON.stringify(input.metadata));
  if (metadata.byteLength > 0xffff) {
    throw new RangeError("Browser screencast metadata is too long");
  }
  const bytes = new Uint8Array(4 + metadata.byteLength + payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = BrowserScreencastOpcode.Frame;
  bytes[1] = input.slot & 0xff;
  view.setUint16(2, metadata.byteLength);
  bytes.set(metadata, 4);
  bytes.set(payload, 4 + metadata.byteLength);
  return bytes;
}

export function decodeBrowserScreencastFrame(bytes: Uint8Array): BrowserScreencastFrame | null {
  if (bytes.byteLength < 4 || bytes[0] !== BrowserScreencastOpcode.Frame) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataLength = view.getUint16(2);
  if (4 + metadataLength > bytes.byteLength) {
    return null;
  }
  const metadata = BrowserScreencastMetadataSchema.safeParse(
    decodeJson(bytes.subarray(4, 4 + metadataLength)),
  );
  if (!metadata.success) {
    return null;
  }
  return {
    opcode: BrowserScreencastOpcode.Frame,
    slot: bytes[1],
    metadata: metadata.data,
    payload: bytes.subarray(4 + metadataLength),
  };
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
