export function copyArrayBufferViewToBuffer(data: ArrayBufferView): ArrayBuffer {
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out.buffer;
}

export function normalizeTransportPayload(
  data: string | Uint8Array | ArrayBuffer,
): string | ArrayBuffer {
  if (typeof data === "string" || data instanceof ArrayBuffer) {
    return data;
  }
  return copyArrayBufferViewToBuffer(data);
}

export interface RelayTransportMessage {
  data: string | ArrayBuffer;
  isBinary: boolean;
}

export function extractRelayMessage(event: unknown, nodeIsBinary?: boolean): RelayTransportMessage {
  const raw =
    event && typeof event === "object" && "data" in event
      ? (event as { data: unknown }).data
      : event;
  const isBinary = nodeIsBinary ?? typeof raw !== "string";
  if (!isBinary) {
    return { data: decodeMessageData(raw) ?? String(raw ?? ""), isBinary: false };
  }
  if (raw instanceof ArrayBuffer) return { data: raw, isBinary: true };
  if (ArrayBuffer.isView(raw)) {
    return { data: copyArrayBufferViewToBuffer(raw), isBinary: true };
  }
  return { data: String(raw ?? ""), isBinary: true };
}

export function describeTransportClose(event?: unknown): string {
  if (!event) {
    return "Transport closed";
  }
  if (event instanceof Error) {
    return event.message;
  }
  if (typeof event === "string") {
    return event;
  }
  if (typeof event === "object") {
    const record = event as { reason?: unknown; message?: unknown; code?: unknown };
    if (typeof record.reason === "string" && record.reason.trim().length > 0) {
      return record.reason.trim();
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message.trim();
    }
    if (typeof record.code === "number") {
      return `Transport closed (code ${record.code})`;
    }
  }
  return "Transport closed";
}

export function describeTransportError(event?: unknown): string {
  if (!event) {
    return "Transport error";
  }
  if (event instanceof Error) {
    return event.message;
  }
  if (typeof event === "string") {
    return event;
  }
  if (typeof event === "object") {
    const record = event as { message?: unknown };
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message.trim();
    }
  }
  return "Transport error";
}

export function safeRandomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function decodeMessageData(data: unknown): string | null {
  if (data === null || data === undefined) {
    return null;
  }
  if (typeof data === "string") {
    return data;
  }
  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(data).toString("utf8");
    }
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder().decode(data);
    }
  }
  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof Buffer !== "undefined") {
      return Buffer.from(view).toString("utf8");
    }
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder().decode(view);
    }
  }
  if (typeof (data as { toString?: () => string }).toString === "function") {
    return (data as { toString: () => string }).toString();
  }
  return null;
}

export function encodeUtf8String(value: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value);
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "utf8"));
  }
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    out[i] = value.charCodeAt(i) & 0xff;
  }
  return out;
}
