import { z } from "zod";
import { TerminalStateSchema } from "../messages.js";

export const TerminalStreamResizeSchema = z.object({
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  intent: z.enum(["claim", "update"]).optional(),
});

export const TerminalStreamOpcode = {
  Output: 0x01,
  Input: 0x02,
  Resize: 0x03,
  Snapshot: 0x04,
  Restore: 0x05,
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
    return encodeUtf8WithoutPlatformApis(data);
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

function encodeUtf8WithoutPlatformApis(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function isTerminalStreamOpcode(value: number): value is TerminalStreamOpcode {
  return (
    value === TerminalStreamOpcode.Output ||
    value === TerminalStreamOpcode.Input ||
    value === TerminalStreamOpcode.Resize ||
    value === TerminalStreamOpcode.Snapshot ||
    value === TerminalStreamOpcode.Restore
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
