export const TerminalStreamOpcode = {
  Output: 0x01,
  Input: 0x02,
  Resize: 0x03,
  Snapshot: 0x04,
  Restore: 0x05,
  ReplayBegin: 0x06,
  ReplayData: 0x07,
  ReplayEnd: 0x08,
} as const;

export type TerminalStreamOpcode = (typeof TerminalStreamOpcode)[keyof typeof TerminalStreamOpcode];

export interface TerminalStreamFrame {
  opcode: TerminalStreamOpcode;
  slot: number;
  payload: Uint8Array;
}

export interface TerminalReplayMetadata {
  rows: number;
  cols: number;
  retainedHistoryLines: number;
}

export function parseTerminalReplayMetadata(input: unknown): TerminalReplayMetadata | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.rows !== "number" ||
    !Number.isInteger(record.rows) ||
    record.rows <= 0 ||
    typeof record.cols !== "number" ||
    !Number.isInteger(record.cols) ||
    record.cols <= 0 ||
    typeof record.retainedHistoryLines !== "number" ||
    !Number.isInteger(record.retainedHistoryLines) ||
    record.retainedHistoryLines < 0
  ) {
    return null;
  }
  return {
    rows: record.rows,
    cols: record.cols,
    retainedHistoryLines: record.retainedHistoryLines,
  };
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
    value === TerminalStreamOpcode.Snapshot ||
    value === TerminalStreamOpcode.ReplayBegin ||
    value === TerminalStreamOpcode.ReplayData ||
    value === TerminalStreamOpcode.ReplayEnd ||
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
