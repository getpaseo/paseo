/// <reference lib="dom" />
/**
 * Endpoint security boundary for relay-carried daemon sessions.
 *
 * A relay data socket arrives here as plaintext bytes. This module runs the
 * shared secure channel over it and hands the secured socket to session
 * admission, together with the negotiated security mode. Relay routing lives in
 * `relay-transport.ts`; credentials and authorization live in admission.
 */
import { EventEmitter } from "node:events";
import type pino from "pino";
import {
  openDaemonSecureChannel,
  SecureChannelRejectedError,
  type KeyPair,
  type SecurityMode,
  type Transport as RelayTransport,
} from "@getpaseo/relay/e2ee";
import { createEncryptedRelaySocket, type EncryptedRelaySocket } from "./encrypted-relay-socket.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface RelayIngressSocket {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
}

export interface SecuredRelaySocket {
  socket: EncryptedRelaySocket;
  securityMode: SecurityMode;
}

export interface SecureRelayIngressOptions {
  daemonKeyPair: KeyPair;
  logger: pino.Logger;
  /**
   * Current policy, read when the peer's hello arrives so a flag flipped at
   * runtime applies to every admission from that moment on.
   */
  requireProtectedMode: () => boolean;
}

/**
 * Secures `socket` and admits it through `attach`. Messages the peer sends
 * before `attach` resolves are delivered once it has.
 *
 * A peer that never completes the handshake is terminated after
 * {@link HANDSHAKE_TIMEOUT_MS}; a failed handshake closes the socket.
 */
export async function admitSecuredRelaySocket(
  socket: RelayIngressSocket,
  options: SecureRelayIngressOptions,
  attach: (secured: SecuredRelaySocket) => Promise<void>,
): Promise<void> {
  const { logger } = options;
  const handshakeTimeout = setTimeout(() => {
    logger.warn("relay_e2ee_handshake_timeout_terminating");
    socket.terminate();
  }, HANDSHAKE_TIMEOUT_MS);
  try {
    const relayTransport = createRelayTransportAdapter(socket, logger);
    const emitter = new EventEmitter();
    const pendingMessages: Array<string | ArrayBuffer> = [];
    let attached = false;
    const emitMessage = (data: string | ArrayBuffer) => {
      if (attached) {
        emitter.emit("message", data);
        return;
      }
      pendingMessages.push(data);
    };
    const channel = await openDaemonSecureChannel(relayTransport, {
      daemonKeyPair: options.daemonKeyPair,
      minimumMode: () => (options.requireProtectedMode() ? "protected" : "legacy"),
      events: {
        onmessage: emitMessage,
        onclose: (code, reason) => emitter.emit("close", code, reason),
        onerror: (error) => {
          logger.warn({ err: error }, "relay_e2ee_error");
          emitter.emit("error", error);
        },
      },
    });
    clearTimeout(handshakeTimeout);
    const encryptedSocket = createEncryptedRelaySocket({
      channel,
      emitter,
      getTransportBufferedAmount: () => socket.bufferedAmount,
      terminateTransport: () => socket.terminate(),
    });
    await attach({ socket: encryptedSocket, securityMode: channel.securityMode() });
    attached = true;
    for (const message of pendingMessages) {
      emitter.emit("message", message);
    }
    pendingMessages.length = 0;
  } catch (error) {
    if (error instanceof SecureChannelRejectedError) {
      logger.warn({ reason: error.message }, "relay_e2ee_handshake_rejected");
      try {
        socket.close(error.closeCode, error.closeReason);
      } catch {
        // ignore
      }
      return;
    }
    logger.warn({ err: error }, "relay_e2ee_handshake_failed");
    try {
      socket.close(1011, "E2EE handshake failed");
    } catch {
      // ignore
    }
  } finally {
    clearTimeout(handshakeTimeout);
  }
}

function createRelayTransportAdapter(
  socket: RelayIngressSocket,
  logger: pino.Logger,
): RelayTransport {
  const relayTransport: RelayTransport = {
    send: (data) =>
      new Promise<void>((resolve, reject) => {
        try {
          socket.send(data, (error) => {
            if (!error) {
              resolve();
              return;
            }
            logger.warn({ err: error }, "relay_socket_send_failed");
            reject(error);
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn({ err }, "relay_socket_send_failed");
          reject(err);
        }
      }),
    close: (code?: number, reason?: string) => socket.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  socket.on("message", (data, isBinary) => {
    const binary = isBinary === true;
    relayTransport.onmessage?.({ data: normalizeMessageData(data, binary), isBinary: binary });
  });
  socket.on("close", (code, reason) => {
    const closeCode = typeof code === "number" ? code : 1006;
    relayTransport.onclose?.(closeCode, String(reason ?? ""));
  });
  socket.on("error", (err) => {
    relayTransport.onerror?.(err instanceof Error ? err : new Error(String(err)));
  });

  return relayTransport;
}

function normalizeMessageData(data: unknown, isBinary: boolean): string | ArrayBuffer {
  if (!isBinary) {
    if (typeof data === "string") return data;
    const buffer = bufferFromWsData(data);
    if (buffer) return buffer.toString("utf8");
    return String(data);
  }

  if (data instanceof ArrayBuffer) return data;

  const buffer = bufferFromWsData(data);
  if (buffer) {
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }

  return String(data);
}

function bufferFromWsData(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) {
    const buffers: Buffer[] = [];
    for (const part of data) {
      if (Buffer.isBuffer(part)) {
        buffers.push(part);
      } else if (part instanceof ArrayBuffer) {
        buffers.push(Buffer.from(part));
      } else if (ArrayBuffer.isView(part)) {
        buffers.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      } else if (typeof part === "string") {
        buffers.push(Buffer.from(part, "utf8"));
      } else {
        return null;
      }
    }
    return Buffer.concat(buffers);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}
