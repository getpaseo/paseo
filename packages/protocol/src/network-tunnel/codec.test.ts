import { describe, expect, it } from "vitest";
import {
  decodeNetworkTunnelFrame,
  encodeNetworkTunnelFrame,
  NETWORK_TUNNEL_DEFAULT_INITIAL_CONNECTION_WINDOW_BYTES,
  NETWORK_TUNNEL_DEFAULT_INITIAL_STREAM_WINDOW_BYTES,
  NETWORK_TUNNEL_HEADER_BYTES,
  NETWORK_TUNNEL_MAX_CONCURRENT_STREAMS,
  NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES,
  NETWORK_TUNNEL_PROTOCOL_VERSION,
  NetworkTunnelCloseReason,
  NetworkTunnelCodecError,
  NetworkTunnelFrameType,
  type NetworkTunnelFrame,
} from "./index.js";

describe("network-tunnel binary codec", () => {
  it("exposes expected protocol constants", () => {
    expect(NETWORK_TUNNEL_PROTOCOL_VERSION).toBe(1);
    expect(NETWORK_TUNNEL_HEADER_BYTES).toBe(16);
    expect(NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES).toBe(64 * 1024);
    expect(NETWORK_TUNNEL_DEFAULT_INITIAL_STREAM_WINDOW_BYTES).toBe(512 * 1024);
    expect(NETWORK_TUNNEL_DEFAULT_INITIAL_CONNECTION_WINDOW_BYTES).toBe(4 * 1024 * 1024);
    expect(NETWORK_TUNNEL_MAX_CONCURRENT_STREAMS).toBe(256);
  });

  it.each<{ name: string; frame: NetworkTunnelFrame; expectedType: NetworkTunnelFrameType }>([
    {
      name: "Open with hostname and port",
      frame: { type: "open", streamId: 1, host: "localhost", port: 5173 },
      expectedType: NetworkTunnelFrameType.Open,
    },
    {
      name: "Open with IPv6 literal",
      frame: { type: "open", streamId: 42, host: "::1", port: 80 },
      expectedType: NetworkTunnelFrameType.Open,
    },
    {
      name: "Opened with initial window",
      frame: { type: "opened", streamId: 7, initialWindowBytes: 512 * 1024 },
      expectedType: NetworkTunnelFrameType.Opened,
    },
    {
      name: "Data with binary bytes",
      frame: {
        type: "data",
        streamId: 9,
        data: new Uint8Array([0, 1, 2, 254, 255]),
      },
      expectedType: NetworkTunnelFrameType.Data,
    },
    {
      name: "Data at exact 64 KiB max payload",
      frame: {
        type: "data",
        streamId: 10,
        data: new Uint8Array(64 * 1024).fill(0xab),
      },
      expectedType: NetworkTunnelFrameType.Data,
    },
    {
      name: "Data with empty payload",
      frame: {
        type: "data",
        streamId: 11,
        data: new Uint8Array(0),
      },
      expectedType: NetworkTunnelFrameType.Data,
    },
    {
      name: "Stream WindowUpdate",
      frame: { type: "window_update", streamId: 3, creditBytes: 65536 },
      expectedType: NetworkTunnelFrameType.WindowUpdate,
    },
    {
      name: "Connection WindowUpdate (streamId 0)",
      frame: { type: "window_update", streamId: 0, creditBytes: 1024 * 1024 },
      expectedType: NetworkTunnelFrameType.WindowUpdate,
    },
    {
      name: "HalfClose",
      frame: { type: "half_close", streamId: 5 },
      expectedType: NetworkTunnelFrameType.HalfClose,
    },
    {
      name: "Close without message",
      frame: { type: "close", streamId: 12, reason: NetworkTunnelCloseReason.Normal },
      expectedType: NetworkTunnelFrameType.Close,
    },
    {
      name: "Close with UTF-8 message",
      frame: {
        type: "close",
        streamId: 13,
        reason: NetworkTunnelCloseReason.PolicyDenied,
        message: "Destination blocked: metadata endpoint 🚫",
      },
      expectedType: NetworkTunnelFrameType.Close,
    },
    {
      name: "Ping without payload",
      frame: { type: "ping" },
      expectedType: NetworkTunnelFrameType.Ping,
    },
    {
      name: "Ping with nonce payload",
      frame: { type: "ping", payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
      expectedType: NetworkTunnelFrameType.Ping,
    },
    {
      name: "Pong with nonce payload",
      frame: { type: "pong", payload: new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]) },
      expectedType: NetworkTunnelFrameType.Pong,
    },
  ])("round-trips $name with fixed 16-byte header", ({ frame, expectedType }) => {
    const encoded = encodeNetworkTunnelFrame(frame);
    expect(encoded.byteLength).toBeGreaterThanOrEqual(NETWORK_TUNNEL_HEADER_BYTES);

    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    expect(view.getUint8(0)).toBe(NETWORK_TUNNEL_PROTOCOL_VERSION);
    expect(view.getUint8(1)).toBe(expectedType);
    expect(view.getUint16(2, false)).toBe(frame.flags ?? 0);
    expect(view.getUint32(8, false)).toBe(encoded.byteLength - NETWORK_TUNNEL_HEADER_BYTES);
    expect(view.getUint32(12, false)).toBe(0);

    const decoded = decodeNetworkTunnelFrame(encoded);
    expect(decoded).toEqual({
      ...frame,
      flags: frame.flags ?? 0,
      ...(frame.type === "ping" || frame.type === "pong"
        ? { payload: frame.payload ?? new Uint8Array(0) }
        : {}),
    });
  });

  it("decodes cleanly from a non-zero byteOffset subarray", () => {
    const encoded = encodeNetworkTunnelFrame({
      type: "open",
      streamId: 99,
      host: "service.localhost",
      port: 3000,
    });
    const padded = new Uint8Array(encoded.byteLength + 10);
    padded.set(encoded, 5);
    const slice = padded.subarray(5, 5 + encoded.byteLength);

    expect(decodeNetworkTunnelFrame(slice)).toEqual({
      type: "open",
      streamId: 99,
      host: "service.localhost",
      port: 3000,
      flags: 0,
    });
  });

  it("rejects truncated, mismatched, unknown, and oversized frames", () => {
    expect(() => decodeNetworkTunnelFrame(new Uint8Array(15))).toThrowError(
      NetworkTunnelCodecError,
    );

    const valid = encodeNetworkTunnelFrame({ type: "half_close", streamId: 1 });

    // Unsupported version
    const badVersion = valid.slice();
    badVersion[0] = 2;
    expect(() => decodeNetworkTunnelFrame(badVersion)).toThrowError(NetworkTunnelCodecError);

    // Unknown frame type
    const badType = valid.slice();
    badType[1] = 99;
    expect(() => decodeNetworkTunnelFrame(badType)).toThrowError(NetworkTunnelCodecError);

    // Payload length header mismatch
    const badLen = valid.slice();
    new DataView(badLen.buffer).setUint32(8, 4, false);
    expect(() => decodeNetworkTunnelFrame(badLen)).toThrowError(NetworkTunnelCodecError);

    // Data payload over 64 KiB on encode
    expect(() =>
      encodeNetworkTunnelFrame({
        type: "data",
        streamId: 1,
        data: new Uint8Array(64 * 1024 + 1),
      }),
    ).toThrowError(NetworkTunnelCodecError);

    // Data payload over 64 KiB on decode
    const huge = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES + 64 * 1024 + 1);
    const hugeView = new DataView(huge.buffer);
    hugeView.setUint8(0, NETWORK_TUNNEL_PROTOCOL_VERSION);
    hugeView.setUint8(1, NetworkTunnelFrameType.Data);
    hugeView.setUint32(4, 1, false);
    hugeView.setUint32(8, 64 * 1024 + 1, false);
    expect(() => decodeNetworkTunnelFrame(huge)).toThrowError(NetworkTunnelCodecError);

    // Invalid streamId 0 for stream-scoped frames
    expect(() =>
      encodeNetworkTunnelFrame({ type: "open", streamId: 0, host: "localhost", port: 80 }),
    ).toThrowError(NetworkTunnelCodecError);
    expect(() =>
      encodeNetworkTunnelFrame({ type: "data", streamId: 0, data: new Uint8Array([1]) }),
    ).toThrowError(NetworkTunnelCodecError);
    expect(() => encodeNetworkTunnelFrame({ type: "half_close", streamId: 0 })).toThrowError(
      NetworkTunnelCodecError,
    );

    // Non-zero streamId on Ping on wire
    const badPing = encodeNetworkTunnelFrame({ type: "ping" }).slice();
    new DataView(badPing.buffer).setUint32(4, 5, false);
    expect(() => decodeNetworkTunnelFrame(badPing)).toThrowError(NetworkTunnelCodecError);

    // Zero credit on WindowUpdate
    expect(() =>
      encodeNetworkTunnelFrame({ type: "window_update", streamId: 1, creditBytes: 0 }),
    ).toThrowError(NetworkTunnelCodecError);

    // Invalid port / empty host on Open
    expect(() =>
      encodeNetworkTunnelFrame({ type: "open", streamId: 1, host: "", port: 80 }),
    ).toThrowError(NetworkTunnelCodecError);
    expect(() =>
      encodeNetworkTunnelFrame({ type: "open", streamId: 1, host: "localhost", port: 0 }),
    ).toThrowError(NetworkTunnelCodecError);
    expect(() =>
      encodeNetworkTunnelFrame({ type: "open", streamId: 1, host: "localhost", port: 65536 }),
    ).toThrowError(NetworkTunnelCodecError);

    // Invalid UTF-8 in Close message
    const badClose = new Uint8Array(NETWORK_TUNNEL_HEADER_BYTES + 4);
    const badCloseView = new DataView(badClose.buffer);
    badCloseView.setUint8(0, NETWORK_TUNNEL_PROTOCOL_VERSION);
    badCloseView.setUint8(1, NetworkTunnelFrameType.Close);
    badCloseView.setUint32(4, 1, false);
    badCloseView.setUint32(8, 4, false);
    badCloseView.setUint16(16, NetworkTunnelCloseReason.InternalError, false);
    badClose[18] = 0xff;
    badClose[19] = 0xfe;
    expect(() => decodeNetworkTunnelFrame(badClose)).toThrowError(NetworkTunnelCodecError);

    // Non-zero reserved bytes
    const badReserved = valid.slice();
    new DataView(badReserved.buffer).setUint32(12, 1, false);
    expect(() => decodeNetworkTunnelFrame(badReserved)).toThrowError(NetworkTunnelCodecError);
  });

  it("handles deterministic malformed fuzz inputs without crashing", () => {
    let seed = 0x12345678;
    const nextByte = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed & 0xff;
    };

    for (let i = 0; i < 200; i += 1) {
      const length = i % 40;
      const bytes = new Uint8Array(length);
      for (let j = 0; j < length; j += 1) bytes[j] = nextByte();
      try {
        decodeNetworkTunnelFrame(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkTunnelCodecError);
      }
    }
  });
});
