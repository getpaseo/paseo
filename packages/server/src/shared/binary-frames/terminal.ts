import { z } from "zod";
import { TerminalStateSchema } from "../messages.js";

export const TerminalStreamResizeSchema = z
  .object({
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
  })
  .strict();

export const TerminalStreamOpcode = {
  Output: 0x01,
  Input: 0x02,
  Resize: 0x03,
  Snapshot: 0x04,
} as const;

export type TerminalStreamOpcode = (typeof TerminalStreamOpcode)[keyof typeof TerminalStreamOpcode];

export interface TerminalStreamFrame {
  opcode: TerminalStreamOpcode;
  slot: number;
  payload: Uint8Array;
}

export function asUint8Array(data: unknown): Uint8Array | null {
  if (typeof data === "string") {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(data);
    }
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(data, "utf8"));
    }
    const out = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      out[index] = data.charCodeAt(index) & 0xff;
    }
    return out;
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function isTerminalStreamOpcode(value: number): value is TerminalStreamOpcode {
  return (
    value === TerminalStreamOpcode.Output ||
    value === TerminalStreamOpcode.Input ||
    value === TerminalStreamOpcode.Resize ||
    value === TerminalStreamOpcode.Snapshot
  );
}

export function encodeTerminalStreamFrame(input: {
  opcode: TerminalStreamOpcode;
  slot: number;
  payload?: Uint8Array | ArrayBuffer | string;
}): Uint8Array {
  const payload = asUint8Array(input.payload ?? new Uint8Array(0)) ?? new Uint8Array(0);
  const bytes = new Uint8Array(2 + payload.byteLength);
  bytes[0] = input.opcode;
  bytes[1] = input.slot & 0xff;
  bytes.set(payload, 2);
  return bytes;
}

export function decodeTerminalStreamFrame(bytes: Uint8Array): TerminalStreamFrame | null {
  if (bytes.byteLength < 2) {
    return null;
  }
  const opcode = bytes[0];
  if (!isTerminalStreamOpcode(opcode)) {
    return null;
  }
  return {
    opcode,
    slot: bytes[1],
    payload: bytes.subarray(2),
  };
}

export function encodeTerminalSnapshotPayload(
  state: z.infer<typeof TerminalStateSchema>,
): Uint8Array {
  return encodeJsonPayload(state);
}

export function decodeTerminalSnapshotPayload(
  bytes: Uint8Array,
): z.infer<typeof TerminalStateSchema> | null {
  const parsed = decodeJsonPayload(bytes);
  const result = TerminalStateSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function encodeTerminalResizePayload(
  input: z.infer<typeof TerminalStreamResizeSchema>,
): Uint8Array {
  return encodeJsonPayload(input);
}

export function decodeTerminalResizePayload(
  bytes: Uint8Array,
): z.infer<typeof TerminalStreamResizeSchema> | null {
  const parsed = decodeJsonPayload(bytes);
  const result = TerminalStreamResizeSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function encodeJsonPayload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodeJsonPayload(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}
