export const TunnelOpcode = {
  Data: 0x20,
  Close: 0x21,
  Open: 0x22,
  Connected: 0x23,
  WindowUpdate: 0x24,
} as const;

export const TunnelCloseReason = {
  Ok: 0,
  GeneralError: 1,
  PolicyDenied: 2,
  NetworkUnreachable: 3,
  HostNotFound: 4,
  ConnectionRefused: 5,
  Timeout: 6,
  StreamLimit: 7,
  ProtocolError: 8,
} as const;
export type TunnelCloseReason = (typeof TunnelCloseReason)[keyof typeof TunnelCloseReason];

export type TunnelTarget =
  | { atyp: 1; address: Uint8Array; port: number }
  | { atyp: 3; address: string; port: number }
  | { atyp: 4; address: Uint8Array; port: number };

interface TunnelStreamIdentity {
  subscriptionId: string;
  streamId: string;
}

export type TunnelFrame = TunnelStreamIdentity &
  (
    | { opcode: typeof TunnelOpcode.Open; target: TunnelTarget }
    | { opcode: typeof TunnelOpcode.Connected }
    | { opcode: typeof TunnelOpcode.Data; payload: Uint8Array }
    | { opcode: typeof TunnelOpcode.Close; reason: TunnelCloseReason }
    | { opcode: typeof TunnelOpcode.WindowUpdate; credit: number }
  );

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isDomain(address: string): boolean {
  if (address.length === 0 || address.length > 255) return false;
  const name = address.endsWith(".") ? address.slice(0, -1) : address;
  return name.split(".").every((label) => /^[a-zA-Z0-9_-]{1,63}$/.test(label));
}

function isIntegerInRange(value: number, max: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= max;
}

function isCloseReason(value: number): value is TunnelCloseReason {
  return Number.isInteger(value) && value >= 0 && value <= TunnelCloseReason.ProtocolError;
}

function encodeId(id: string): Uint8Array {
  const bytes = encoder.encode(id);
  // TextEncoder replaces unpaired surrogates; IDs must survive a round trip unchanged.
  if (bytes.length === 0 || bytes.length > 255 || decoder.decode(bytes) !== id) {
    throw new RangeError("Tunnel IDs must contain 1–255 bytes of valid UTF-8");
  }
  return bytes;
}

function encodeTarget(target: TunnelTarget): Uint8Array {
  if (!isIntegerInRange(target.port, 65535)) throw new RangeError("Invalid tunnel port");
  let address: Uint8Array;
  let addressOffset: number;
  switch (target.atyp) {
    case 1:
    case 4: {
      const expectedLength = target.atyp === 1 ? 4 : 16;
      if (target.address.length !== expectedLength) throw new RangeError("Invalid IP length");
      address = target.address;
      addressOffset = 1;
      break;
    }
    case 3:
      if (!isDomain(target.address)) throw new RangeError("Invalid tunnel domain");
      address = encoder.encode(target.address);
      addressOffset = 2;
      break;
    default:
      throw new RangeError("Unknown tunnel address type");
  }
  const body = new Uint8Array(addressOffset + address.length + 2);
  body[0] = target.atyp;
  if (target.atyp === 3) body[1] = address.length;
  body.set(address, addressOffset);
  new DataView(body.buffer).setUint16(body.length - 2, target.port);
  return body;
}

function encodeBody(frame: TunnelFrame): Uint8Array {
  switch (frame.opcode) {
    case TunnelOpcode.Open:
      return encodeTarget(frame.target);
    case TunnelOpcode.Connected:
      return new Uint8Array();
    case TunnelOpcode.Data:
      if (frame.payload.length === 0) {
        throw new RangeError("Invalid tunnel data length");
      }
      return frame.payload;
    case TunnelOpcode.Close:
      if (!isCloseReason(frame.reason)) throw new RangeError("Unknown tunnel close reason");
      return new Uint8Array([frame.reason]);
    case TunnelOpcode.WindowUpdate: {
      if (!isIntegerInRange(frame.credit, 0xffffffff)) {
        throw new RangeError("Invalid tunnel credit");
      }
      const body = new Uint8Array(4);
      new DataView(body.buffer).setUint32(0, frame.credit);
      return body;
    }
    default:
      throw new RangeError("Unknown tunnel opcode");
  }
}

export function encodeTunnelFrame(frame: TunnelFrame): Uint8Array {
  const subscriptionId = encodeId(frame.subscriptionId);
  const streamId = encodeId(frame.streamId);
  const body = encodeBody(frame);
  const bytes = new Uint8Array(3 + subscriptionId.length + streamId.length + body.length);
  bytes[0] = frame.opcode;
  bytes[1] = subscriptionId.length;
  bytes.set(subscriptionId, 2);
  bytes[2 + subscriptionId.length] = streamId.length;
  bytes.set(streamId, 3 + subscriptionId.length);
  bytes.set(body, 3 + subscriptionId.length + streamId.length);
  return bytes;
}

function decodeTarget(body: Uint8Array): TunnelTarget | null {
  if (body.length < 4) return null;
  const atyp = body[0];
  const port = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint16(
    body.length - 2,
  );
  if (port === 0) return null;
  if (atyp === 1 && body.length === 7) return { atyp, address: body.subarray(1, 5), port };
  if (atyp === 4 && body.length === 19) return { atyp, address: body.subarray(1, 17), port };
  if (atyp !== 3 || body[1] !== body.length - 4) return null;
  const address = decoder.decode(body.subarray(2, body.length - 2));
  return isDomain(address) ? { atyp, address, port } : null;
}

export function decodeTunnelFrame(bytes: Uint8Array): TunnelFrame | null {
  if (bytes.length < 5) return null;
  const subscriptionLength = bytes[1];
  const streamLengthOffset = 2 + subscriptionLength;
  if (subscriptionLength === 0 || streamLengthOffset >= bytes.length) return null;
  const streamLength = bytes[streamLengthOffset];
  const bodyOffset = streamLengthOffset + 1 + streamLength;
  if (streamLength === 0 || bodyOffset > bytes.length) return null;

  try {
    const subscriptionId = decoder.decode(bytes.subarray(2, streamLengthOffset));
    const streamId = decoder.decode(bytes.subarray(streamLengthOffset + 1, bodyOffset));
    const identity = { subscriptionId, streamId };
    const body = bytes.subarray(bodyOffset);
    const opcode = bytes[0];
    switch (opcode) {
      case TunnelOpcode.Open: {
        const target = decodeTarget(body);
        return target ? { ...identity, opcode, target } : null;
      }
      case TunnelOpcode.Connected:
        return body.length === 0 ? { ...identity, opcode } : null;
      case TunnelOpcode.Data:
        return body.length > 0 ? { ...identity, opcode, payload: body } : null;
      case TunnelOpcode.Close:
        return body.length === 1 && isCloseReason(body[0])
          ? { ...identity, opcode, reason: body[0] }
          : null;
      case TunnelOpcode.WindowUpdate: {
        if (body.length !== 4) return null;
        const credit = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
        return credit > 0 ? { ...identity, opcode, credit } : null;
      }
      default:
        return null;
    }
  } catch (error) {
    // Fatal TextDecoder rejects malformed UTF-8 at the network boundary.
    if (error instanceof TypeError) return null;
    throw error;
  }
}
