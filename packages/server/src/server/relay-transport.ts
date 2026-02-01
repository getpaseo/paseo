/// <reference lib="dom" />
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type pino from "pino";
import {
  createDaemonChannel,
  type EncryptedChannel,
  type Transport as RelayTransport,
} from "@paseo/relay";

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

    const url = buildRelayWebSocketUrl(relayEndpoint, sessionId, "server");
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

  socket.on("message", (data) => {
    relayTransport.onmessage?.(normalizeMessageData(data));
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

function normalizeMessageData(data: unknown): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }
  if (Buffer.isBuffer(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }
  return String(data);
}

function buildRelayWebSocketUrl(
  relayEndpoint: string,
  sessionId: string,
  role: "server" | "client"
): string {
  const { host, port } = parseHostPort(relayEndpoint);
  const protocol = port === 443 ? "wss" : "ws";
  return `${protocol}://${host}:${port}/ws?session=${encodeURIComponent(
    sessionId
  )}&role=${role}`;
}

function parseHostPort(input: string): { host: string; port: number } {
  const trimmed = input.trim();

  if (trimmed.startsWith("[")) {
    const endIdx = trimmed.indexOf("]");
    if (endIdx === -1) {
      throw new Error(`Invalid relay endpoint: ${input}`);
    }
    const host = trimmed.slice(1, endIdx);
    const rest = trimmed.slice(endIdx + 1);
    if (!rest.startsWith(":")) {
      throw new Error(`Invalid relay endpoint: ${input}`);
    }
    const port = Number.parseInt(rest.slice(1), 10);
    if (!Number.isFinite(port)) {
      throw new Error(`Invalid relay port: ${input}`);
    }
    return { host: `[${host}]`, port };
  }

  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) {
    throw new Error(`Invalid relay endpoint (expected host:port): ${input}`);
  }
  const host = trimmed.slice(0, idx);
  const port = Number.parseInt(trimmed.slice(idx + 1), 10);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`Invalid relay endpoint: ${input}`);
  }
  return { host, port };
}
