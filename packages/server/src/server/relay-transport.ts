/// <reference lib="dom" />
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type pino from "pino";
import {
  createDaemonChannel,
  type EncryptedChannel,
  type Transport as RelayTransport,
  type KeyPair,
} from "@paseo/relay/e2ee";
import { buildRelayWebSocketUrl } from "../shared/daemon-endpoints.js";

type RelayTransportOptions = {
  logger: pino.Logger;
  attachSocket: (ws: RelaySocketLike) => Promise<void>;
  relayEndpoint: string; // "host:port"
  serverId: string;
  daemonKeyPair?: KeyPair;
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

type ControlMessage =
  | { type: "sync"; clientIds: string[] }
  | { type: "client_connected"; clientId: string }
  | { type: "client_disconnected"; clientId: string };

function tryParseControlMessage(raw: unknown): ControlMessage | null {
  try {
    const text =
      typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const parsed = JSON.parse(text) as any;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.type === "sync" && Array.isArray(parsed.clientIds)) {
      const clientIds = parsed.clientIds.filter((id: unknown) => typeof id === "string" && id.trim().length > 0);
      return { type: "sync", clientIds };
    }
    if (parsed.type === "client_connected" && typeof parsed.clientId === "string" && parsed.clientId.trim()) {
      return { type: "client_connected", clientId: parsed.clientId.trim() };
    }
    if (parsed.type === "client_disconnected" && typeof parsed.clientId === "string" && parsed.clientId.trim()) {
      return { type: "client_disconnected", clientId: parsed.clientId.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function startRelayTransport({
  logger,
  attachSocket,
  relayEndpoint,
  serverId,
  daemonKeyPair,
}: RelayTransportOptions): RelayTransportController {
  const relayLogger = logger.child({ module: "relay-transport" });

  let stopped = false;
  let controlWs: WebSocket | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const dataSockets = new Map<string, WebSocket>(); // clientId -> ws

  const stop = async (): Promise<void> => {
    stopped = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (controlWs) {
      try {
        controlWs.close();
      } catch {
        // ignore
      }
      controlWs = null;
    }
    for (const ws of dataSockets.values()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    dataSockets.clear();
  };

  const connectControl = (): void => {
    if (stopped) return;

    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      serverId,
      role: "server",
    });
    const socket = new WebSocket(url);
    controlWs = socket;

    socket.on("open", () => {
      reconnectAttempt = 0;
      relayLogger.info({ url }, "relay_control_connected");
    });

    socket.on("close", (code, reason) => {
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url },
        "relay_control_disconnected"
      );
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      relayLogger.warn({ err, url }, "relay_error");
      // close event will schedule reconnect
    });

    socket.on("message", (data) => {
      const msg = tryParseControlMessage(data);
      if (!msg) return;
      if (msg.type === "sync") {
        for (const clientId of msg.clientIds) {
          ensureClientDataSocket(clientId);
        }
        return;
      }
      if (msg.type === "client_connected") {
        ensureClientDataSocket(msg.clientId);
        return;
      }
      if (msg.type === "client_disconnected") {
        const existing = dataSockets.get(msg.clientId);
        if (existing) {
          try {
            existing.close(1001, "Client disconnected");
          } catch {
            // ignore
          }
          dataSockets.delete(msg.clientId);
        }
      }
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimeout) return;

    reconnectAttempt += 1;
    const delayMs = Math.min(30000, 1000 * reconnectAttempt);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      connectControl();
    }, delayMs);
  };

  const ensureClientDataSocket = (clientId: string): void => {
    if (stopped) return;
    if (!clientId) return;
    if (dataSockets.has(clientId)) return;

    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      serverId,
      role: "server",
      clientId,
    });
    const socket = new WebSocket(url);
    dataSockets.set(clientId, socket);

    let attached = false;

    socket.on("open", () => {
      relayLogger.info({ url, clientId }, "relay_data_connected");
      if (attached) return;
      attached = true;
      if (daemonKeyPair) {
        void attachEncryptedSocket(socket, daemonKeyPair, relayLogger.child({ clientId }), attachSocket);
      } else {
        void attachSocket(socket);
      }
    });

    socket.on("close", (code, reason) => {
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, clientId },
        "relay_data_disconnected"
      );
      if (dataSockets.get(clientId) === socket) {
        dataSockets.delete(clientId);
      }
    });

    socket.on("error", (err) => {
      relayLogger.warn({ err, url, clientId }, "relay_data_error");
    });
  };

  connectControl();

  return { stop };
}

async function attachEncryptedSocket(
  socket: WebSocket,
  daemonKeyPair: KeyPair,
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
