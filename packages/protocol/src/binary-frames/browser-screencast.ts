export const BrowserScreencastOpcode = {
  Frame: 0x20,
  Ack: 0x21,
} as const;

const FRAME_HEADER_BYTES = 10;
const ACK_BYTES = 6;

/** A JPEG viewport frame; width and height are the page viewport in CSS pixels. */
export interface BrowserScreencastFrame {
  opcode: typeof BrowserScreencastOpcode.Frame;
  slot: number;
  sequence: number;
  width: number;
  height: number;
  payload: Uint8Array;
}

/** Acknowledges every frame up to and including sequence; the daemon paces on it. */
export interface BrowserScreencastAck {
  opcode: typeof BrowserScreencastOpcode.Ack;
  slot: number;
  sequence: number;
}

export type BrowserScreencastBinaryFrame = BrowserScreencastFrame | BrowserScreencastAck;

export function encodeBrowserScreencastFrame(
  input: Omit<BrowserScreencastFrame, "opcode">,
): Uint8Array {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + input.payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = BrowserScreencastOpcode.Frame;
  bytes[1] = input.slot & 0xff;
  view.setUint32(2, input.sequence);
  view.setUint16(6, input.width);
  view.setUint16(8, input.height);
  bytes.set(input.payload, FRAME_HEADER_BYTES);
  return bytes;
}

export function encodeBrowserScreencastAck(
  input: Omit<BrowserScreencastAck, "opcode">,
): Uint8Array {
  const bytes = new Uint8Array(ACK_BYTES);
  bytes[0] = BrowserScreencastOpcode.Ack;
  bytes[1] = input.slot & 0xff;
  new DataView(bytes.buffer).setUint32(2, input.sequence);
  return bytes;
}

export function decodeBrowserScreencastFrame(
  bytes: Uint8Array,
): BrowserScreencastBinaryFrame | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === BrowserScreencastOpcode.Ack && bytes.byteLength === ACK_BYTES) {
    return { opcode: BrowserScreencastOpcode.Ack, slot: bytes[1], sequence: view.getUint32(2) };
  }
  if (bytes[0] === BrowserScreencastOpcode.Frame && bytes.byteLength > FRAME_HEADER_BYTES) {
    return {
      opcode: BrowserScreencastOpcode.Frame,
      slot: bytes[1],
      sequence: view.getUint32(2),
      width: view.getUint16(6),
      height: view.getUint16(8),
      payload: bytes.subarray(FRAME_HEADER_BYTES),
    };
  }
  return null;
}
