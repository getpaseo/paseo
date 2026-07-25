import { EventEmitter } from "node:events";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES, outboundFrameByteLength } from "./physical-socket.js";

// NaCl adds a 24-byte nonce and 16-byte authenticator before base64 encoding.
const ENCRYPTED_FRAME_OVERHEAD_BYTES = 40;

export interface EncryptedRelayChannel {
  setState: (state: "open") => void;
  send: (data: string | ArrayBuffer) => Promise<void>;
  close: (code?: number, reason?: string) => void;
}

export interface EncryptedRelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

export function createEncryptedRelaySocket(params: {
  channel: EncryptedRelayChannel;
  emitter: EventEmitter;
  getTransportBufferedAmount: () => number | undefined;
  terminateTransport: () => void;
}): EncryptedRelaySocket {
  const { channel, emitter, getTransportBufferedAmount, terminateTransport } = params;
  let readyState = 1;
  let pendingEncryptedBytes = 0;

  channel.setState("open");

  const terminate = () => {
    if (readyState === 3) return;
    readyState = 3;
    terminateTransport();
  };

  const close = (code?: number, reason?: string) => {
    if (readyState === 3) return;
    readyState = 3;
    channel.close(code, reason);
  };

  emitter.on("close", () => {
    readyState = 3;
  });

  return {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return pendingEncryptedBytes + (getTransportBufferedAmount() ?? 0);
    },
    send: (data) => {
      if (readyState !== 1) return;
      const outbound = normalizeRelaySendPayload(data);
      const outboundBytes = encryptedRelayFrameByteLength(outbound);
      const queuedBytes = pendingEncryptedBytes + (getTransportBufferedAmount() ?? 0);
      if (queuedBytes + outboundBytes > MAX_PHYSICAL_SOCKET_BUFFERED_BYTES) {
        terminate();
        return;
      }
      pendingEncryptedBytes += outboundBytes;
      void channel
        .send(outbound)
        .catch((error) => {
          emitter.emit("error", error);
        })
        .finally(() => {
          pendingEncryptedBytes -= outboundBytes;
        });
    },
    close,
    terminate,
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    once: (event, listener) => {
      emitter.once(event, listener);
    },
  };
}

function normalizeRelaySendPayload(data: string | Uint8Array | ArrayBuffer): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out.buffer;
}

function encryptedRelayFrameByteLength(data: string | ArrayBuffer): number {
  const encryptedBytes = outboundFrameByteLength(data) + ENCRYPTED_FRAME_OVERHEAD_BYTES;
  return 4 * Math.ceil(encryptedBytes / 3);
}
