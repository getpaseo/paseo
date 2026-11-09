import { MAX_ROUTED_PAYLOAD_BYTES } from "./host-route.js";

/**
 * Plugin values that are a `Uint8Array` travel as binary frames. Opcodes 0x20-0x2f are
 * reserved for plugin traffic. Every frame is `[opcode][id length u8][id]...` and the payload
 * is the rest of the frame, decoded as a view so no hop copies it.
 */
export const PluginFrameOpcode = {
  /** `[0x20][id length][subscriptionId][payload]`: a subscription event. */
  Event: 0x20,
  /** `[0x21][id length][requestId][payload]`: an RPC output; no JSON response follows. */
  Output: 0x21,
  /** `[0x22][id length][requestId][header length u16][header JSON][payload]`: an RPC input. */
  Input: 0x22,
} as const;

export type PluginFrameOpcode = (typeof PluginFrameOpcode)[keyof typeof PluginFrameOpcode];

/** The largest frame header: an input's opcode, ID and header JSON, each at its maximum length. */
const MAX_PLUGIN_FRAME_HEADER_BYTES = 2 + 0xff + 2 + 0xffff;

/** The largest `Uint8Array` a plugin value carries, so its frame fits in one routed message. */
export const MAX_PLUGIN_PAYLOAD_BYTES = MAX_ROUTED_PAYLOAD_BYTES - MAX_PLUGIN_FRAME_HEADER_BYTES;

export type PluginFrame =
  | { opcode: typeof PluginFrameOpcode.Event; subscriptionId: string; payload: Uint8Array }
  | { opcode: typeof PluginFrameOpcode.Output; requestId: string; payload: Uint8Array }
  | {
      opcode: typeof PluginFrameOpcode.Input;
      requestId: string;
      pluginId: string;
      method: string;
      payload: Uint8Array;
    };

export function isPluginFrameOpcode(value: number | undefined): value is PluginFrameOpcode {
  return (
    value === PluginFrameOpcode.Event ||
    value === PluginFrameOpcode.Output ||
    value === PluginFrameOpcode.Input
  );
}

export function encodePluginEventFrame(subscriptionId: string, payload: Uint8Array): Uint8Array {
  return encodeFrame(PluginFrameOpcode.Event, subscriptionId, new Uint8Array(0), payload);
}

export function encodePluginOutputFrame(requestId: string, payload: Uint8Array): Uint8Array {
  return encodeFrame(PluginFrameOpcode.Output, requestId, new Uint8Array(0), payload);
}

export function encodePluginInputFrame(input: {
  requestId: string;
  pluginId: string;
  method: string;
  payload: Uint8Array;
}): Uint8Array {
  const header = new TextEncoder().encode(
    JSON.stringify({ pluginId: input.pluginId, method: input.method }),
  );
  if (header.byteLength > 0xffff) throw new RangeError("Plugin input header is too long");
  const prefix = new Uint8Array(2 + header.byteLength);
  new DataView(prefix.buffer).setUint16(0, header.byteLength);
  prefix.set(header, 2);
  return encodeFrame(PluginFrameOpcode.Input, input.requestId, prefix, input.payload);
}

export function decodePluginFrame(bytes: Uint8Array): PluginFrame | null {
  const opcode = bytes[0];
  if (bytes.byteLength < 2 || !isPluginFrameOpcode(opcode)) return null;
  const idLength = bytes[1];
  if (idLength === 0 || idLength > bytes.byteLength - 2) return null;
  const id = new TextDecoder().decode(bytes.subarray(2, 2 + idLength));
  const body = bytes.subarray(2 + idLength);
  if (opcode === PluginFrameOpcode.Event) return { opcode, subscriptionId: id, payload: body };
  if (opcode === PluginFrameOpcode.Output) return { opcode, requestId: id, payload: body };
  if (body.byteLength < 2) return null;
  const headerLength = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint16(0);
  if (headerLength > body.byteLength - 2) return null;
  const header = decodeInputHeader(body.subarray(2, 2 + headerLength));
  if (!header) return null;
  return { opcode, requestId: id, ...header, payload: body.subarray(2 + headerLength) };
}

function encodeFrame(
  opcode: PluginFrameOpcode,
  id: string,
  prefix: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  const idBytes = new TextEncoder().encode(id);
  if (idBytes.byteLength === 0) throw new RangeError("Plugin frame ID is required");
  if (idBytes.byteLength > 0xff) throw new RangeError("Plugin frame ID is too long");
  const headerLength = 2 + idBytes.byteLength + prefix.byteLength;
  const frame = new Uint8Array(headerLength + payload.byteLength);
  frame[0] = opcode;
  frame[1] = idBytes.byteLength;
  frame.set(idBytes, 2);
  frame.set(prefix, 2 + idBytes.byteLength);
  frame.set(payload, headerLength);
  return frame;
}

function decodeInputHeader(bytes: Uint8Array): { pluginId: string; method: string } | null {
  try {
    const header: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof header !== "object" || header === null) return null;
    const pluginId = Reflect.get(header, "pluginId");
    const method = Reflect.get(header, "method");
    if (typeof pluginId !== "string" || typeof method !== "string" || !pluginId || !method)
      return null;
    return { pluginId, method };
  } catch {
    return null;
  }
}

/**
 * The byte rule: a plugin value is either a `Uint8Array`, sent as a binary frame, or a JSON value
 * with no `Uint8Array` inside it. Checks object structure only; never reads the bytes.
 */
export function assertPluginWireValue(value: unknown, label: string): void {
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_PLUGIN_PAYLOAD_BYTES)
      throw new RangeError(
        `${label} is ${value.byteLength} bytes; one value carries at most ${MAX_PLUGIN_PAYLOAD_BYTES} bytes`,
      );
    return;
  }
  const nested = findNestedBytes(value, label);
  if (nested)
    throw new TypeError(
      `${nested} is a Uint8Array. Bytes cross the wire only as the whole value: send the Uint8Array itself, or encode it into the value.`,
    );
}

function findNestedBytes(value: unknown, path: string): string | null {
  if (value instanceof Uint8Array) return path;
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findNestedBytes(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    const found = findNestedBytes(entry, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}
