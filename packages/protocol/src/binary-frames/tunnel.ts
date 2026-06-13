import { asUint8Array } from "./terminal.js";

/**
 * Binary frames for the TCP port-forward tunnel.
 *
 * A tunnel multiplexes many raw TCP streams (one per browser connection to a
 * forwarded dev-server port) over the single daemon WebSocket the client
 * already holds. Each stream is identified by a string `streamId` allocated by
 * the client (the side that accepts the local browser connection).
 *
 * The whole control+data plane lives in this binary family so byte ordering is
 * trivially preserved on the single ordered channel — there are no JSON
 * messages involved, only the `server_info.features.tcpTunnel` capability flag
 * that gates whether the client attempts a tunnel at all:
 *
 *   - `Open`  (client → daemon): open a stream to `127.0.0.1:port`.
 *   - `Data`  (both ways):       raw TCP bytes for a stream.
 *   - `Close` (both ways):       the stream ended; carries a reason byte.
 *
 * Wire layout mirrors the file-transfer family: `[opcode][idLen][id…][body…]`.
 * Opcodes live in the 0x20 range (terminal uses 0x01-0x05, file-transfer 0x10-0x12).
 */
export const TunnelStreamOpcode = {
  Data: 0x20,
  Close: 0x21,
  Open: 0x22,
} as const;

export type TunnelStreamOpcode = (typeof TunnelStreamOpcode)[keyof typeof TunnelStreamOpcode];

export const TunnelCloseReason = {
  /** Either side closed the stream normally (EOF / browser navigated away). */
  Normal: 0x00,
  /** The daemon could not connect to the loopback target (dev server down). */
  ConnectFailed: 0x01,
} as const;

export type TunnelCloseReason = (typeof TunnelCloseReason)[keyof typeof TunnelCloseReason];

export interface TunnelOpenFrame {
  opcode: typeof TunnelStreamOpcode.Open;
  streamId: string;
  /** Loopback port on the daemon host to forward to. */
  port: number;
}

export interface TunnelDataFrame {
  opcode: typeof TunnelStreamOpcode.Data;
  streamId: string;
  payload: Uint8Array;
}

export interface TunnelCloseFrame {
  opcode: typeof TunnelStreamOpcode.Close;
  streamId: string;
  reason: number;
}

export type TunnelStreamFrame = TunnelOpenFrame | TunnelDataFrame | TunnelCloseFrame;

type TunnelStreamFrameInput =
  | { opcode: typeof TunnelStreamOpcode.Open; streamId: string; port: number }
  | {
      opcode: typeof TunnelStreamOpcode.Data;
      streamId: string;
      payload?: Uint8Array | ArrayBuffer | string;
    }
  | { opcode: typeof TunnelStreamOpcode.Close; streamId: string; reason?: number };

export function encodeTunnelStreamFrame(input: TunnelStreamFrameInput): Uint8Array {
  const streamId = encodeStreamId(input.streamId);

  let body: Uint8Array;
  if (input.opcode === TunnelStreamOpcode.Open) {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 0xffff) {
      throw new RangeError("Tunnel open port must be a uint16");
    }
    body = new Uint8Array(2);
    new DataView(body.buffer).setUint16(0, input.port);
  } else if (input.opcode === TunnelStreamOpcode.Data) {
    body = asUint8Array(input.payload ?? new Uint8Array()) ?? new Uint8Array();
  } else {
    body = new Uint8Array([(input.reason ?? TunnelCloseReason.Normal) & 0xff]);
  }

  const bytes = new Uint8Array(2 + streamId.byteLength + body.byteLength);
  bytes[0] = input.opcode;
  bytes[1] = streamId.byteLength;
  bytes.set(streamId, 2);
  bytes.set(body, 2 + streamId.byteLength);
  return bytes;
}

export function decodeTunnelStreamFrame(bytes: Uint8Array): TunnelStreamFrame | null {
  if (bytes.byteLength < 2) {
    return null;
  }
  const opcode = bytes[0];
  if (!isTunnelStreamOpcode(opcode)) {
    return null;
  }
  const streamIdLength = bytes[1];
  if (streamIdLength === 0 || streamIdLength > bytes.byteLength - 2) {
    return null;
  }

  const streamId = decodeStreamId(bytes.subarray(2, 2 + streamIdLength));
  const body = bytes.subarray(2 + streamIdLength);

  if (opcode === TunnelStreamOpcode.Data) {
    return { opcode, streamId, payload: body };
  }

  if (opcode === TunnelStreamOpcode.Open) {
    if (body.byteLength !== 2) {
      return null;
    }
    const port = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint16(0);
    if (port === 0) {
      return null;
    }
    return { opcode, streamId, port };
  }

  // Close: tolerate an empty body (reason defaults to Normal) or exactly one reason byte.
  if (body.byteLength > 1) {
    return null;
  }
  return {
    opcode,
    streamId,
    reason: body.byteLength === 1 ? body[0] : TunnelCloseReason.Normal,
  };
}

export function isTunnelStreamOpcode(value: number): value is TunnelStreamOpcode {
  return (
    value === TunnelStreamOpcode.Data ||
    value === TunnelStreamOpcode.Close ||
    value === TunnelStreamOpcode.Open
  );
}

function encodeStreamId(streamId: string): Uint8Array {
  const bytes = new TextEncoder().encode(streamId);
  if (bytes.byteLength === 0) {
    throw new RangeError("Tunnel streamId is required");
  }
  if (bytes.byteLength > 0xff) {
    throw new RangeError("Tunnel streamId is too long");
  }
  return bytes;
}

function decodeStreamId(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
