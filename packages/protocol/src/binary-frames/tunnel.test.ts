import { describe, expect, it } from "vitest";
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TunnelOpcode,
  TunnelCloseReason,
  type TunnelFrame,
} from "./tunnel.js";

describe("tunnel frames", () => {
  it("encodes a domain open with subscription ownership and a big-endian port", () => {
    const frame = {
      opcode: TunnelOpcode.Open,
      subscriptionId: "s",
      streamId: "t",
      target: { atyp: 3, address: "intranet", port: 8080 },
    } as const;
    const bytes = new Uint8Array([
      0x22, 1, 115, 1, 116, 3, 8, 105, 110, 116, 114, 97, 110, 101, 116, 0x1f, 0x90,
    ]);
    expect(encodeTunnelFrame(frame)).toEqual(bytes);
    expect(decodeTunnelFrame(bytes)).toEqual(frame);
  });
});

const identity = { subscriptionId: "sub-é", streamId: "流" };
const frames: TunnelFrame[] = [
  {
    ...identity,
    opcode: TunnelOpcode.Open,
    target: { atyp: 1, address: new Uint8Array([127, 0, 0, 1]), port: 1 },
  },
  {
    ...identity,
    opcode: TunnelOpcode.Open,
    target: {
      atyp: 4,
      address: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
      port: 65535,
    },
  },
  { ...identity, opcode: TunnelOpcode.Connected },
  { ...identity, opcode: TunnelOpcode.Data, payload: new Uint8Array([0, 255, 128, 1]) },
  { ...identity, opcode: TunnelOpcode.Close, reason: TunnelCloseReason.ConnectionRefused },
  { ...identity, opcode: TunnelOpcode.WindowUpdate, credit: 0x010203 },
];

describe("tunnel codec boundaries", () => {
  it.each(frames)("round trips opcode $opcode including offset views", (frame) => {
    const encoded = encodeTunnelFrame(frame);
    const padded = new Uint8Array(encoded.length + 8);
    padded.set(encoded, 3);
    expect(decodeTunnelFrame(padded.subarray(3, 3 + encoded.length))).toEqual(frame);
  });

  it("writes window credit in network byte order", () => {
    expect(
      encodeTunnelFrame({
        subscriptionId: "s",
        streamId: "t",
        opcode: TunnelOpcode.WindowUpdate,
        credit: 0x010203,
      }),
    ).toEqual(new Uint8Array([0x24, 1, 115, 1, 116, 0, 1, 2, 3]));
  });

  it.each(Object.values(TunnelCloseReason))("preserves close reason %i", (reason) => {
    const frame = { ...identity, opcode: TunnelOpcode.Close, reason };
    expect(decodeTunnelFrame(encodeTunnelFrame(frame))).toEqual(frame);
  });

  it.each(["localhost", "intranet", "xn--bcher-kva.example", "service_name.internal."])(
    "preserves domain %s without resolving it",
    (address) => {
      const frame: TunnelFrame = {
        ...identity,
        opcode: TunnelOpcode.Open,
        target: { atyp: 3, address, port: 443 },
      };
      expect(decodeTunnelFrame(encodeTunnelFrame(frame))).toEqual(frame);
    },
  );

  it("accepts maximum ID lengths without imposing default data or credit limits", () => {
    const frame: TunnelFrame = {
      subscriptionId: "é".repeat(127) + "x",
      streamId: "a".repeat(255),
      opcode: TunnelOpcode.Data,
      payload: new Uint8Array(65537),
    };
    expect(decodeTunnelFrame(encodeTunnelFrame(frame))).toEqual(frame);
    const credit: TunnelFrame = {
      ...identity,
      opcode: TunnelOpcode.WindowUpdate,
      credit: 0xffffffff,
    };
    expect(decodeTunnelFrame(encodeTunnelFrame(credit))).toEqual(credit);
  });

  it.each(["", "x".repeat(256), "é".repeat(128), "\ud800"])(
    "rejects IDs outside the UTF-8 byte contract (%j)",
    (id) => {
      expect(() =>
        encodeTunnelFrame({ ...identity, subscriptionId: id, opcode: TunnelOpcode.Connected }),
      ).toThrow(RangeError);
      expect(() =>
        encodeTunnelFrame({ ...identity, streamId: id, opcode: TunnelOpcode.Connected }),
      ).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, 65536, NaN, Infinity])("rejects invalid port %s", (port) => {
    expect(() =>
      encodeTunnelFrame({
        ...identity,
        opcode: TunnelOpcode.Open,
        target: { atyp: 3, address: "localhost", port },
      }),
    ).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, 2 ** 32, NaN, Infinity])("rejects invalid credit %s", (credit) => {
    expect(() =>
      encodeTunnelFrame({ ...identity, opcode: TunnelOpcode.WindowUpdate, credit }),
    ).toThrow(RangeError);
  });

  it.each([
    "",
    ".",
    "a..b",
    "a/",
    "a:80",
    "user@host",
    "a b",
    "a\0b",
    "bücher.example",
    "a".repeat(64),
    "a.".repeat(128),
  ])("rejects invalid domain %j", (address) => {
    expect(() =>
      encodeTunnelFrame({
        ...identity,
        opcode: TunnelOpcode.Open,
        target: { atyp: 3, address, port: 80 },
      }),
    ).toThrow(RangeError);
  });

  it("rejects empty data", () => {
    expect(() =>
      encodeTunnelFrame({
        ...identity,
        opcode: TunnelOpcode.Data,
        payload: new Uint8Array(),
      }),
    ).toThrow(RangeError);
  });

  it.each([0, 3, 5, 15, 17])("rejects invalid IP size %i", (length) => {
    expect(() =>
      encodeTunnelFrame({
        ...identity,
        opcode: TunnelOpcode.Open,
        target: { atyp: 1, address: new Uint8Array(length), port: 80 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      encodeTunnelFrame({
        ...identity,
        opcode: TunnelOpcode.Open,
        target: { atyp: 4, address: new Uint8Array(length), port: 80 },
      }),
    ).toThrow(RangeError);
  });

  it.each([
    [],
    [0x23],
    [0x23, 0, 1, 116],
    [0x23, 255, 115, 1, 116],
    [0x23, 1, 115],
    [0x23, 1, 115, 0],
    [0x23, 1, 115, 2, 116],
    [0x23, 1, 0xff, 1, 116],
    [0x23, 1, 115, 1, 0xff],
    [0x23, 2, 0xc0, 0xaf, 1, 116],
  ])("rejects malformed headers %j", (...bytes) => {
    expect(decodeTunnelFrame(new Uint8Array(bytes))).toBeNull();
  });

  it.each([
    [0x22, 2, 127, 0, 0, 1, 0, 80], // unknown atyp
    [0x22, 1, 127, 0, 0, 1, 0], // truncated port
    [0x22, 1, 127, 0, 0, 1, 0, 0], // zero port
    [0x22, 1, 127, 0, 0, 1, 0, 80, 1], // trailing address data
    [0x22, 4, 0, 0, 1, 0, 80], // truncated IPv6
    [0x22, 3, 0, 0, 80], // empty domain
    [0x22, 3, 2, 97, 0, 80], // truncated domain
    [0x22, 3, 1, 0xff, 0, 80], // malformed domain UTF-8
    [0x22, 3, 1, 0, 0, 80], // NUL domain
    [0x23, 1],
    [0x20],
    [0x21],
    [0x21, 9],
    [0x21, 0, 0],
    [0x24, 0, 0, 0],
    [0x24, 0, 0, 0, 1, 0],
    [0x24, 0, 0, 0, 0],
    [0x25],
    [0x2f],
    [0xff],
  ])("rejects malformed body or opcode %j", (opcode, ...body) => {
    expect(decodeTunnelFrame(new Uint8Array([opcode, 1, 115, 1, 116, ...body]))).toBeNull();
  });

  it("accepts received data larger than the default RPC limit", () => {
    const bytes = new Uint8Array(5 + 65537);
    bytes.set([0x20, 1, 115, 1, 116]);
    expect(decodeTunnelFrame(bytes)).toEqual({
      opcode: TunnelOpcode.Data,
      subscriptionId: "s",
      streamId: "t",
      payload: bytes.subarray(5),
    });
  });

  it.each([
    { body: [0, 4, 0, 1], credit: 262145 },
    { body: [255, 255, 255, 255], credit: 0xffffffff },
  ])("accepts received u32 credit $credit beyond the default window", ({ body, credit }) => {
    const bytes = new Uint8Array([0x24, 1, 115, 1, 116, ...body]);
    expect(decodeTunnelFrame(bytes)).toEqual({
      opcode: TunnelOpcode.WindowUpdate,
      subscriptionId: "s",
      streamId: "t",
      credit,
    });
  });

  it("rejects every truncation of an Open frame", () => {
    const bytes = encodeTunnelFrame({
      ...identity,
      opcode: TunnelOpcode.Open,
      target: { atyp: 3, address: "intranet", port: 8080 },
    });
    for (let length = 0; length < bytes.length; length++) {
      expect(decodeTunnelFrame(bytes.subarray(0, length))).toBeNull();
    }
  });
});
