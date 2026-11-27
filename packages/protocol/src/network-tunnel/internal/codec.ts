export const NETWORK_TUNNEL_PROTOCOL_VERSION = 1;
export const NETWORK_TUNNEL_HEADER_BYTES = 16;
export const NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES = 64 * 1024;
export const NETWORK_TUNNEL_DEFAULT_INITIAL_STREAM_WINDOW_BYTES = 512 * 1024;
export const NETWORK_TUNNEL_DEFAULT_INITIAL_CONNECTION_WINDOW_BYTES = 4 * 1024 * 1024;
export const NETWORK_TUNNEL_MAX_CONCURRENT_STREAMS = 256;

const MAX_HOST_BYTES = 1024;
const MAX_CLOSE_MESSAGE_BYTES = 1024;
const MAX_PING_PAYLOAD_BYTES = 64;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

export enum NetworkTunnelFrameType {
  Open = 1,
  Opened = 2,
  Data = 3,
  WindowUpdate = 4,
  HalfClose = 5,
  Close = 6,
  Ping = 7,
  Pong = 8,
}

export enum NetworkTunnelCloseReason {
  Normal = 0,
  RemoteClosed = 1,
  ConnectRefused = 2,
  HostUnreachable = 3,
  DnsFailed = 4,
  PolicyDenied = 5,
  Timeout = 6,
  StreamLimitExceeded = 7,
  FlowControlError = 8,
  ProtocolError = 9,
  InternalError = 10,
  Reset = 11,
}

export type NetworkTunnelCodecErrorCode =
  | "truncated_header"
  | "unsupported_version"
  | "unknown_frame_type"
  | "length_mismatch"
  | "payload_too_large"
  | "invalid_stream_id"
  | "invalid_flags"
  | "invalid_reserved"
  | "invalid_payload"
  | "invalid_utf8";

export class NetworkTunnelCodecError extends Error {
  readonly code: NetworkTunnelCodecErrorCode;

  constructor(code: NetworkTunnelCodecErrorCode, message: string) {
    super(message);
    this.name = "NetworkTunnelCodecError";
    this.code = code;
  }
}

export type NetworkTunnelFrame =
  | {
      type: "open";
      streamId: number;
      host: string;
      port: number;
      flags?: number;
    }
  | {
      type: "opened";
      streamId: number;
      initialWindowBytes: number;
      flags?: number;
    }
  | {
      type: "data";
      streamId: number;
      data: Uint8Array;
      flags?: number;
    }
  | {
      type: "window_update";
      streamId: number;
      creditBytes: number;
      flags?: number;
    }
  | {
      type: "half_close";
      streamId: number;
      flags?: number;
    }
  | {
      type: "close";
      streamId: number;
      reason: NetworkTunnelCloseReason;
      message?: string;
      flags?: number;
    }
  | {
      type: "ping";
      payload?: Uint8Array;
      flags?: number;
    }
  | {
      type: "pong";
      payload?: Uint8Array;
      flags?: number;
    };

export type DecodedNetworkTunnelFrame =
  | {
      type: "open";
      streamId: number;
      host: string;
      port: number;
      flags: number;
    }
  | {
      type: "opened";
      streamId: number;
      initialWindowBytes: number;
      flags: number;
    }
  | {
      type: "data";
      streamId: number;
      data: Uint8Array;
      flags: number;
    }
  | {
      type: "window_update";
      streamId: number;
      creditBytes: number;
      flags: number;
    }
  | {
      type: "half_close";
      streamId: number;
      flags: number;
    }
  | {
      type: "close";
      streamId: number;
      reason: NetworkTunnelCloseReason;
      message?: string;
      flags: number;
    }
  | {
      type: "ping";
      payload: Uint8Array;
      flags: number;
    }
  | {
      type: "pong";
      payload: Uint8Array;
      flags: number;
    };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isValidCloseReason(value: number): value is NetworkTunnelCloseReason {
  return (
    Number.isInteger(value) &&
    value >= NetworkTunnelCloseReason.Normal &&
    value <= NetworkTunnelCloseReason.Reset
  );
}

function assertUint16(value: number, code: NetworkTunnelCodecErrorCode, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT16) {
    throw new NetworkTunnelCodecError(code, `Invalid ${name}: ${value}`);
  }
}

function assertUint32(value: number, code: NetworkTunnelCodecErrorCode, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new NetworkTunnelCodecError(code, `Invalid ${name}: ${value}`);
  }
}

function assertPositiveStreamId(streamId: number): void {
  assertUint32(streamId, "invalid_stream_id", "streamId");
  if (streamId === 0) {
    throw new NetworkTunnelCodecError("invalid_stream_id", "Stream frame requires streamId >= 1");
  }
}

function writeHeader(
  out: Uint8Array,
  frameType: NetworkTunnelFrameType,
  flags: number,
  streamId: number,
  payloadLength: number,
): DataView {
  assertUint16(flags, "invalid_flags", "flags");
  assertUint32(streamId, "invalid_stream_id", "streamId");
  assertUint32(payloadLength, "invalid_payload", "payloadLength");
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, NETWORK_TUNNEL_PROTOCOL_VERSION);
  view.setUint8(1, frameType);
  view.setUint16(2, flags, false);
  view.setUint32(4, streamId, false);
  view.setUint32(8, payloadLength, false);
  view.setUint32(12, 0, false);
  return view;
}

function decodeUtf8Strict(bytes: Uint8Array, label: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new NetworkTunnelCodecError("invalid_utf8", `Invalid UTF-8 in ${label}`);
  }
}

function encodeOpenFrame(
  frame: Extract<NetworkTunnelFrame, { type: "open" }>,
  flags: number,
): Uint8Array {
  assertPositiveStreamId(frame.streamId);
  if (!Number.isInteger(frame.port) || frame.port < 1 || frame.port > MAX_UINT16) {
    throw new NetworkTunnelCodecError("invalid_payload", `Invalid port: ${frame.port}`);
  }
  const hostBytes = textEncoder.encode(frame.host);
  if (hostBytes.byteLength === 0 || hostBytes.byteLength > MAX_HOST_BYTES) {
    throw new NetworkTunnelCodecError(
      "invalid_payload",
      `Invalid host length: ${hostBytes.byteLength}`,
    );
  }
  const payloadLength = 4 + hostBytes.byteLength;
  const out = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES + payloadLength);
  const view = writeHeader(out, NetworkTunnelFrameType.Open, flags, frame.streamId, payloadLength);
  view.setUint16(NETWORK_TUNNEL_HEADER_BYTES, frame.port, false);
  view.setUint16(NETWORK_TUNNEL_HEADER_BYTES + 2, hostBytes.byteLength, false);
  out.set(hostBytes, NETWORK_TUNNEL_HEADER_BYTES + 4);
  return out;
}

function encodeCloseFrame(
  frame: Extract<NetworkTunnelFrame, { type: "close" }>,
  flags: number,
): Uint8Array {
  assertPositiveStreamId(frame.streamId);
  if (!isValidCloseReason(frame.reason)) {
    throw new NetworkTunnelCodecError("invalid_payload", `Invalid close reason: ${frame.reason}`);
  }
  const messageBytes =
    frame.message !== undefined ? textEncoder.encode(frame.message) : new Uint8Array(0);
  if (messageBytes.byteLength > MAX_CLOSE_MESSAGE_BYTES) {
    throw new NetworkTunnelCodecError(
      "payload_too_large",
      `Close message length ${messageBytes.byteLength} exceeds max ${MAX_CLOSE_MESSAGE_BYTES}`,
    );
  }
  const payloadLength = 2 + messageBytes.byteLength;
  const out = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES + payloadLength);
  const view = writeHeader(out, NetworkTunnelFrameType.Close, flags, frame.streamId, payloadLength);
  view.setUint16(NETWORK_TUNNEL_HEADER_BYTES, frame.reason, false);
  if (messageBytes.byteLength > 0) {
    out.set(messageBytes, NETWORK_TUNNEL_HEADER_BYTES + 2);
  }
  return out;
}

function encodePingPongFrame(
  frame: Extract<NetworkTunnelFrame, { type: "ping" | "pong" }>,
  flags: number,
): Uint8Array {
  const payload = frame.payload ?? new Uint8Array(0);
  if (payload.byteLength > MAX_PING_PAYLOAD_BYTES) {
    throw new NetworkTunnelCodecError(
      "payload_too_large",
      `${frame.type} payload length ${payload.byteLength} exceeds max ${MAX_PING_PAYLOAD_BYTES}`,
    );
  }
  const out = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES + payload.byteLength);
  writeHeader(
    out,
    frame.type === "ping" ? NetworkTunnelFrameType.Ping : NetworkTunnelFrameType.Pong,
    flags,
    0,
    payload.byteLength,
  );
  if (payload.byteLength > 0) {
    out.set(payload, NETWORK_TUNNEL_HEADER_BYTES);
  }
  return out;
}

export function encodeNetworkTunnelFrame(frame: NetworkTunnelFrame): Uint8Array {
  const flags = frame.flags ?? 0;

  switch (frame.type) {
    case "open":
      return encodeOpenFrame(frame, flags);

    case "opened": {
      assertPositiveStreamId(frame.streamId);
      assertUint32(frame.initialWindowBytes, "invalid_payload", "initialWindowBytes");
      const out = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES + 4);
      const view = writeHeader(out, NetworkTunnelFrameType.Opened, flags, frame.streamId, 4);
      view.setUint32(NETWORK_TUNNEL_HEADER_BYTES, frame.initialWindowBytes, false);
      return out;
    }

    case "data": {
      assertPositiveStreamId(frame.streamId);
      if (frame.data.byteLength > NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES) {
        throw new NetworkTunnelCodecError(
          "payload_too_large",
          `Data payload ${frame.data.byteLength} exceeds max ${NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES}`,
        );
      }
      const out = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES + frame.data.byteLength);
      writeHeader(out, NetworkTunnelFrameType.Data, flags, frame.streamId, frame.data.byteLength);
      out.set(frame.data, NETWORK_TUNNEL_HEADER_BYTES);
      return out;
    }

    case "window_update": {
      assertUint32(frame.streamId, "invalid_stream_id", "streamId");
      assertUint32(frame.creditBytes, "invalid_payload", "creditBytes");
      if (frame.creditBytes === 0) {
        throw new NetworkTunnelCodecError(
          "invalid_payload",
          "WindowUpdate creditBytes must be > 0",
        );
      }
      const out = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES + 4);
      const view = writeHeader(out, NetworkTunnelFrameType.WindowUpdate, flags, frame.streamId, 4);
      view.setUint32(NETWORK_TUNNEL_HEADER_BYTES, frame.creditBytes, false);
      return out;
    }

    case "half_close": {
      assertPositiveStreamId(frame.streamId);
      const out = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES);
      writeHeader(out, NetworkTunnelFrameType.HalfClose, flags, frame.streamId, 0);
      return out;
    }

    case "close":
      return encodeCloseFrame(frame, flags);

    case "ping":
    case "pong":
      return encodePingPongFrame(frame, flags);
  }
}

interface DecodedHeader {
  frameType: number;
  flags: number;
  streamId: number;
  payloadLength: number;
  view: DataView;
  payload: Uint8Array;
}

function parseHeader(bytes: Uint8Array): DecodedHeader {
  if (bytes.byteLength < NETWORK_TUNNEL_HEADER_BYTES) {
    throw new NetworkTunnelCodecError(
      "truncated_header",
      `Expected at least ${NETWORK_TUNNEL_HEADER_BYTES} bytes, got ${bytes.byteLength}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== NETWORK_TUNNEL_PROTOCOL_VERSION) {
    throw new NetworkTunnelCodecError(
      "unsupported_version",
      `Unsupported network tunnel protocol version: ${version}`,
    );
  }

  const frameType = view.getUint8(1);
  const flags = view.getUint16(2, false);
  const streamId = view.getUint32(4, false);
  const payloadLength = view.getUint32(8, false);
  const reserved = view.getUint32(12, false);

  if (reserved !== 0) {
    throw new NetworkTunnelCodecError("invalid_reserved", "Reserved header bits must be 0");
  }

  const actualPayloadLength = bytes.byteLength - NETWORK_TUNNEL_HEADER_BYTES;
  if (payloadLength !== actualPayloadLength) {
    throw new NetworkTunnelCodecError(
      "length_mismatch",
      `Header payloadLength ${payloadLength} does not match buffer payload length ${actualPayloadLength}`,
    );
  }

  return {
    frameType,
    flags,
    streamId,
    payloadLength,
    view,
    payload: bytes.subarray(NETWORK_TUNNEL_HEADER_BYTES),
  };
}

function decodeOpenFrame(header: DecodedHeader): DecodedNetworkTunnelFrame {
  if (header.streamId === 0) {
    throw new NetworkTunnelCodecError("invalid_stream_id", "Open requires streamId >= 1");
  }
  if (header.payloadLength < 4) {
    throw new NetworkTunnelCodecError("invalid_payload", "Open payload too short");
  }
  const port = header.view.getUint16(NETWORK_TUNNEL_HEADER_BYTES, false);
  const hostLength = header.view.getUint16(NETWORK_TUNNEL_HEADER_BYTES + 2, false);
  if (port < 1) {
    throw new NetworkTunnelCodecError("invalid_payload", `Invalid Open port: ${port}`);
  }
  if (hostLength === 0 || hostLength > MAX_HOST_BYTES) {
    throw new NetworkTunnelCodecError("invalid_payload", `Invalid Open host length: ${hostLength}`);
  }
  if (header.payloadLength !== 4 + hostLength) {
    throw new NetworkTunnelCodecError(
      "invalid_payload",
      `Open payload length ${header.payloadLength} does not match host length ${hostLength}`,
    );
  }
  const host = decodeUtf8Strict(header.payload.subarray(4, 4 + hostLength), "Open host");
  return { type: "open", streamId: header.streamId, host, port, flags: header.flags };
}

function decodeCloseFrame(header: DecodedHeader): DecodedNetworkTunnelFrame {
  if (header.streamId === 0) {
    throw new NetworkTunnelCodecError("invalid_stream_id", "Close requires streamId >= 1");
  }
  if (header.payloadLength < 2) {
    throw new NetworkTunnelCodecError("invalid_payload", "Close payload too short");
  }
  if (header.payloadLength - 2 > MAX_CLOSE_MESSAGE_BYTES) {
    throw new NetworkTunnelCodecError(
      "payload_too_large",
      `Close message exceeds max ${MAX_CLOSE_MESSAGE_BYTES} bytes`,
    );
  }
  const reason = header.view.getUint16(NETWORK_TUNNEL_HEADER_BYTES, false);
  if (!isValidCloseReason(reason)) {
    throw new NetworkTunnelCodecError("invalid_payload", `Unknown close reason: ${reason}`);
  }
  if (header.payloadLength === 2) {
    return { type: "close", streamId: header.streamId, reason, flags: header.flags };
  }
  const message = decodeUtf8Strict(header.payload.subarray(2), "Close message");
  return { type: "close", streamId: header.streamId, reason, message, flags: header.flags };
}

function decodePingPongFrame(
  type: "ping" | "pong",
  header: DecodedHeader,
): DecodedNetworkTunnelFrame {
  if (header.streamId !== 0) {
    throw new NetworkTunnelCodecError("invalid_stream_id", `${type} requires streamId === 0`);
  }
  if (header.payloadLength > MAX_PING_PAYLOAD_BYTES) {
    throw new NetworkTunnelCodecError(
      "payload_too_large",
      `${type} payload exceeds max ${MAX_PING_PAYLOAD_BYTES} bytes`,
    );
  }
  return { type, payload: header.payload.slice(), flags: header.flags };
}

function decodeOpenedFrame(header: DecodedHeader): DecodedNetworkTunnelFrame {
  if (header.streamId === 0) {
    throw new NetworkTunnelCodecError("invalid_stream_id", "Opened requires streamId >= 1");
  }
  if (header.payloadLength !== 4) {
    throw new NetworkTunnelCodecError("invalid_payload", "Opened payload must be 4 bytes");
  }
  const initialWindowBytes = header.view.getUint32(NETWORK_TUNNEL_HEADER_BYTES, false);
  return {
    type: "opened",
    streamId: header.streamId,
    initialWindowBytes,
    flags: header.flags,
  };
}

function decodeDataFrame(header: DecodedHeader): DecodedNetworkTunnelFrame {
  if (header.streamId === 0) {
    throw new NetworkTunnelCodecError("invalid_stream_id", "Data requires streamId >= 1");
  }
  if (header.payloadLength > NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES) {
    throw new NetworkTunnelCodecError(
      "payload_too_large",
      `Data payload ${header.payloadLength} exceeds max ${NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES}`,
    );
  }
  return {
    type: "data",
    streamId: header.streamId,
    data: header.payload.slice(),
    flags: header.flags,
  };
}

function decodeWindowUpdateFrame(header: DecodedHeader): DecodedNetworkTunnelFrame {
  if (header.payloadLength !== 4) {
    throw new NetworkTunnelCodecError("invalid_payload", "WindowUpdate payload must be 4 bytes");
  }
  const creditBytes = header.view.getUint32(NETWORK_TUNNEL_HEADER_BYTES, false);
  if (creditBytes === 0) {
    throw new NetworkTunnelCodecError("invalid_payload", "WindowUpdate creditBytes must be > 0");
  }
  return {
    type: "window_update",
    streamId: header.streamId,
    creditBytes,
    flags: header.flags,
  };
}

function decodeHalfCloseFrame(header: DecodedHeader): DecodedNetworkTunnelFrame {
  if (header.streamId === 0) {
    throw new NetworkTunnelCodecError("invalid_stream_id", "HalfClose requires streamId >= 1");
  }
  if (header.payloadLength !== 0) {
    throw new NetworkTunnelCodecError("invalid_payload", "HalfClose payload must be empty");
  }
  return { type: "half_close", streamId: header.streamId, flags: header.flags };
}

export function decodeNetworkTunnelFrame(bytes: Uint8Array): DecodedNetworkTunnelFrame {
  const header = parseHeader(bytes);

  switch (header.frameType) {
    case NetworkTunnelFrameType.Open:
      return decodeOpenFrame(header);
    case NetworkTunnelFrameType.Opened:
      return decodeOpenedFrame(header);
    case NetworkTunnelFrameType.Data:
      return decodeDataFrame(header);
    case NetworkTunnelFrameType.WindowUpdate:
      return decodeWindowUpdateFrame(header);
    case NetworkTunnelFrameType.HalfClose:
      return decodeHalfCloseFrame(header);
    case NetworkTunnelFrameType.Close:
      return decodeCloseFrame(header);
    case NetworkTunnelFrameType.Ping:
      return decodePingPongFrame("ping", header);
    case NetworkTunnelFrameType.Pong:
      return decodePingPongFrame("pong", header);
    default:
      throw new NetworkTunnelCodecError(
        "unknown_frame_type",
        `Unknown network tunnel frame type: ${header.frameType}`,
      );
  }
}
