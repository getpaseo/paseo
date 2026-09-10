import { EventEmitter } from "node:events";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./physical-socket.js";
import { MAX_RELAY_PAYLOAD_BYTES } from "./relay-payload.js";

export interface EncryptedRelayChannel {
  setState: (state: "open") => void;
  send: (data: string | ArrayBuffer) => Promise<void>;
  outboundWireByteLength: (data: string | ArrayBuffer) => number;
  close: (code?: number, reason?: string) => void;
}

export interface EncryptedRelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void | Promise<void>;
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
  onOversizedMessage?: (details: {
    plaintextBytes: number;
    wireBytes: number;
    queuedBytes: number;
    maxWireBytes: number;
  }) => void;
}): EncryptedRelaySocket {
  const { channel, emitter, getTransportBufferedAmount, terminateTransport } = params;
  let readyState = 1;

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
      return getTransportBufferedAmount() ?? 0;
    },
    send: (data) => {
      if (readyState !== 1) {
        return Promise.reject(new Error("Encrypted relay socket is not open"));
      }
      const outbound = normalizeRelaySendPayload(data);
      const outboundBytes = channel.outboundWireByteLength(outbound);
      const queuedBytes = getTransportBufferedAmount() ?? 0;
      if (outboundBytes > MAX_RELAY_PAYLOAD_BYTES) {
        terminate();
        params.onOversizedMessage?.({
          plaintextBytes:
            typeof outbound === "string" ? Buffer.byteLength(outbound) : outbound.byteLength,
          wireBytes: outboundBytes,
          queuedBytes,
          maxWireBytes: MAX_RELAY_PAYLOAD_BYTES,
        });
        return Promise.reject(new Error("Encrypted message exceeded the relay payload limit"));
      }
      if (queuedBytes + outboundBytes > MAX_PHYSICAL_SOCKET_BUFFERED_BYTES) {
        terminate();
        return Promise.reject(
          new Error("Encrypted relay socket exceeded its outbound high-water mark"),
        );
      }
      return channel.send(outbound).catch((error) => {
        if (readyState === 1) {
          terminate();
          emitter.emit("error", error);
        }
        throw error;
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
