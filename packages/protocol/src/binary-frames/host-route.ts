import { MAX_WEBSOCKET_MESSAGE_BYTES } from "../websocket-message-limit.js";
/** Routing adds a bounded header; the enclosed terminal/file frame is never re-encoded. */
export const HOST_ROUTE_OPCODE = 0x30;
export const MAX_HOST_ROUTE_ID_BYTES = 256;
export const MAX_HOST_ROUTE_HEADER_BYTES = 3 + MAX_HOST_ROUTE_ID_BYTES;
export const MAX_ROUTED_PAYLOAD_BYTES = MAX_WEBSOCKET_MESSAGE_BYTES - MAX_HOST_ROUTE_HEADER_BYTES;
export interface HostRouteFrame {
  routeId: string;
  payload: Uint8Array;
}
export function encodeHostRouteFrame(routeId: string, payload: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(routeId);
  if (!id.length || id.length > MAX_HOST_ROUTE_ID_BYTES) throw new Error("Invalid host route ID");
  if (payload.byteLength > MAX_ROUTED_PAYLOAD_BYTES) throw new Error("Host frame is too large");
  const frame = new Uint8Array(3 + id.length + payload.byteLength);
  frame[0] = HOST_ROUTE_OPCODE;
  new DataView(frame.buffer).setUint16(1, id.length);
  frame.set(id, 3);
  frame.set(payload, 3 + id.length);
  return frame;
}
export function decodeHostRouteFrame(bytes: Uint8Array): HostRouteFrame | null {
  if (bytes[0] !== HOST_ROUTE_OPCODE || bytes.length < 3) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(1);
  if (!length || length > MAX_HOST_ROUTE_ID_BYTES || bytes.length < 3 + length) return null;
  if (bytes.length - 3 - length > MAX_ROUTED_PAYLOAD_BYTES) return null;
  try {
    const routeId = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3, 3 + length));
    return { routeId, payload: bytes.subarray(3 + length) };
  } catch {
    return null;
  }
}
