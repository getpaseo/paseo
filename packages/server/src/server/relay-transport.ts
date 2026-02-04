/// <reference lib="dom" />
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type pino from "pino";
import {
  createDaemonChannel,
  type EncryptedChannel,
  type Transport as RelayTransport,
} from "@paseo/relay/e2ee";
import { buildRelayWebSocketUrl } from "../shared/daemon-endpoints.js";

type RelayTransportOptions = {
  logger: pino.Logger;
  attachSocket: (ws: RelaySocketLike) => Promise<void>;
  relayEndpoint: string; // "host:port"
  sessionId: string;
  daemonKeyPair?: CryptoKeyPair;
};

export type RelayTransportController = {
  stop: () => Promise<void>;
};

type RelaySocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: "message" | "close" | "error", listener: (...args: any[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: any[]) => void) => void;
};

export function startRelayTransport({
  logger,
  attachSocket,
  relayEndpoint,
  sessionId,
  daemonKeyPair,
}: RelayTransportOptions): RelayTransportController {
  const relayLogger = logger.child({ module: "relay-transport" });

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const stop = async (): Promise<void> => {
    stopped = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };

  const connect = (): void => {
    if (stopped) return;

    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      sessionId,
      role: "server",
    });
    const socket = new WebSocket(url);
    ws = socket;

    let attached = false;

    socket.on("open", () => {
      reconnectAttempt = 0;
      relayLogger.info({ url }, "relay_connected");

      if (attached) return;
      attached = true;
      if (daemonKeyPair) {
        void attachEncryptedSocket(socket, daemonKeyPair, relayLogger, attachSocket);
      } else {
        void attachSocket(socket);
      }
    });

    socket.on("close", (code, reason) => {
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url },
        "relay_disconnected"
      );
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      relayLogger.warn({ err, url }, "relay_error");
      // close event will schedule reconnect
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimeout) return;

    reconnectAttempt += 1;
    const delayMs = Math.min(30000, 1000 * reconnectAttempt);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      connect();
    }, delayMs);
  };

  connect();

  return { stop };
}

async function attachEncryptedSocket(
  socket: WebSocket,
  daemonKeyPair: CryptoKeyPair,
  logger: pino.Logger,
  attachSocket: (ws: RelaySocketLike) => Promise<void>
): Promise<void> {
  try {
    const relayTransport = createRelayTransportAdapter(socket);
    const emitter = new EventEmitter();
    const channel = await createDaemonChannel(relayTransport, daemonKeyPair, {
      onmessage: (data) => emitter.emit("message", data),
      onclose: (code, reason) => emitter.emit("close", code, reason),
      onerror: (error) => {
        logger.warn({ err: error }, "relay_e2ee_error");
        emitter.emit("error", error);
      },
    });
    const encryptedSocket = createEncryptedSocket(channel, emitter);
    await attachSocket(encryptedSocket);
  } catch (error) {
    logger.warn({ err: error }, "relay_e2ee_handshake_failed");
    try {
      socket.close(1011, "E2EE handshake failed");
    } catch {
      // ignore
    }
  }
}

function createRelayTransportAdapter(socket: WebSocket): RelayTransport {
  const relayTransport: RelayTransport = {
    send: (data) => socket.send(data),
    close: (code?: number, reason?: string) => socket.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  socket.on("message", (data, isBinary) => {
    relayTransport.onmessage?.(normalizeMessageData(data, isBinary));
  });
  socket.on("close", (code, reason) => {
    relayTransport.onclose?.(code, reason.toString());
  });
  socket.on("error", (err) => {
    relayTransport.onerror?.(err instanceof Error ? err : new Error(String(err)));
  });

  return relayTransport;
}

function createEncryptedSocket(
  channel: EncryptedChannel,
  emitter: EventEmitter
): RelaySocketLike {
  let readyState = 1;

  channel.setState("open");

  const close = (code?: number, reason?: string) => {
    if (readyState === 3) return;
    readyState = 3;
    channel.close(code, reason);
  };

  emitter.on("close", () => {
    if (readyState === 3) return;
    readyState = 3;
  });

  return {
    get readyState() {
      return readyState;
    },
    send: (data) => {
      void channel.send(data).catch((error) => {
        emitter.emit("error", error);
      });
    },
    close,
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    once: (event, listener) => {
      emitter.once(event, listener);
    },
  };
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

// buildRelayWebSocketUrl + parseHostPort live in ../shared/daemon-endpoints.ts
