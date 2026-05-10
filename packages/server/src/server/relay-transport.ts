/// <reference lib="dom" />
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type pino from "pino";
import {
  createDaemonChannel,
  type EncryptedChannel,
  type Transport as RelayTransport,
  type KeyPair,
} from "@getpaseo/relay/e2ee";
import { buildRelayWebSocketUrl } from "../shared/daemon-endpoints.js";
import type { ExternalSocketMetadata } from "./websocket-server.js";

interface RelayTransportOptions {
  logger: pino.Logger;
  attachSocket: (ws: RelaySocketLike, metadata?: ExternalSocketMetadata) => Promise<void>;
  relayEndpoint: string; // "host:port"
  relayUseTls: boolean;
  serverId: string;
  daemonKeyPair?: KeyPair;
  createWebSocket?: RelayWebSocketFactory;
}

export interface RelayTransportController {
  stop: () => Promise<void>;
}

interface RelaySocketLike {
  readyState: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

interface RelayWebSocketLike extends RelaySocketLike {
  terminate: () => void;
  on: (
    event: "open" | "message" | "close" | "error",
    listener: (...args: unknown[]) => void,
  ) => void;
}

type RelayWebSocketFactory = (url: string) => RelayWebSocketLike;

type ControlMessage =
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string }
  | { type: "ping" }
  | { type: "pong" };

const CONTROL_PING_INTERVAL_MS = 10_000;
const CONTROL_STALE_TIMEOUT_MS = 30_000;
const CONTROL_READY_TIMEOUT_MS = 8_000;
const RELAY_WEBSOCKET_OPTIONS = { handshakeTimeout: 10_000, perMessageDeflate: false } as const;

function createDefaultRelayWebSocket(url: string): RelayWebSocketLike {
  return new WebSocket(url, RELAY_WEBSOCKET_OPTIONS);
}

function normalizeRelaySendPayload(data: string | Uint8Array | ArrayBuffer): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }
  return String(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tryParseControlMessage(raw: unknown): ControlMessage | null {
  try {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString("utf8");
    } else {
      text = String(raw);
    }
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed.type === "ping") return { type: "ping" };
    if (parsed.type === "pong") return { type: "pong" };
    if (parsed.type === "sync" && Array.isArray(parsed.connectionIds)) {
      const connectionIds = parsed.connectionIds.filter(
        (id: unknown) => typeof id === "string" && id.trim().length > 0,
      );
      return { type: "sync", connectionIds };
    }
    if (
      parsed.type === "connected" &&
      typeof parsed.connectionId === "string" &&
      parsed.connectionId.trim()
    ) {
      return { type: "connected", connectionId: parsed.connectionId.trim() };
    }
    if (
      parsed.type === "disconnected" &&
      typeof parsed.connectionId === "string" &&
      parsed.connectionId.trim()
    ) {
      return { type: "disconnected", connectionId: parsed.connectionId.trim() };
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
  relayUseTls,
  serverId,
  daemonKeyPair,
  createWebSocket = createDefaultRelayWebSocket,
}: RelayTransportOptions): RelayTransportController {
  const relayLogger = logger.child({ module: "relay-transport" });

  let stopped = false;
  let controlWs: RelayWebSocketLike | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const dataSockets = new Map<string, RelayWebSocketLike>(); // connectionId -> ws
  let controlKeepaliveInterval: ReturnType<typeof setInterval> | null = null;
  let controlReadyTimeout: ReturnType<typeof setTimeout> | null = null;
  let controlLastSeenAt = 0;
  let controlConnectionSeq = 0;

  const stop = async (): Promise<void> => {
    stopped = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (controlKeepaliveInterval) {
      clearInterval(controlKeepaliveInterval);
      controlKeepaliveInterval = null;
    }
    if (controlReadyTimeout) {
      clearTimeout(controlReadyTimeout);
      controlReadyTimeout = null;
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

    const connectionId = ++controlConnectionSeq;
    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls: relayUseTls,
      serverId,
      role: "server",
    });
    const socket = createWebSocket(url);
    controlWs = socket;
    let controlConnected = false;

    const markControlReady = () => {
      if (controlWs !== socket) return;
      if (controlConnected) return;
      controlConnected = true;
      reconnectAttempt = 0;
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      relayLogger.info({ connectionId }, "relay_control_connected");
    };

    socket.on("open", () => {
      if (controlWs !== socket) return;

      controlLastSeenAt = Date.now();
      if (controlKeepaliveInterval) {
        clearInterval(controlKeepaliveInterval);
        controlKeepaliveInterval = null;
      }
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      controlReadyTimeout = setTimeout(() => {
        if (stopped) return;
        if (controlWs !== socket) return;
        if (controlConnected) return;
        relayLogger.warn(
          { url, connectionId, waitedMs: CONTROL_READY_TIMEOUT_MS },
          "relay_control_ready_timeout_terminating",
        );
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }, CONTROL_READY_TIMEOUT_MS);
      controlKeepaliveInterval = setInterval(() => {
        if (stopped) return;
        if (controlWs !== socket) return;
        if (socket.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const staleForMs = now - controlLastSeenAt;
        // If the control socket is half-open or silently dropped, ws may never emit "close".
        // Use app-level ping/pong to detect staleness and force a reconnect.
        if (staleForMs > CONTROL_STALE_TIMEOUT_MS) {
          relayLogger.warn(
            { url, staleForMs, connectionId, staleTimeoutMs: CONTROL_STALE_TIMEOUT_MS },
            "relay_control_stale_terminating",
          );
          try {
            socket.terminate();
          } catch {
            // ignore
          }
          return;
        }

        try {
          socket.send(JSON.stringify({ type: "ping", ts: now }));
        } catch (error) {
          relayLogger.warn({ err: error, connectionId }, "relay_control_ping_send_failed");
          try {
            socket.terminate();
          } catch {
            // ignore
          }
        }
      }, CONTROL_PING_INTERVAL_MS);
      try {
        socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch (error) {
        relayLogger.warn({ err: error, connectionId }, "relay_control_ping_send_failed");
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      relayLogger.debug({ connectionId }, "relay_control_open_waiting_for_ready");
    });

    socket.on("close", (code, reason) => {
      if (controlWs !== socket) return;
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, connectionId },
        "relay_control_disconnected",
      );
      controlWs = null;
      if (controlKeepaliveInterval) {
        clearInterval(controlKeepaliveInterval);
        controlKeepaliveInterval = null;
      }
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      if (controlWs !== socket) return;
      relayLogger.warn({ err, connectionId }, "relay_error");
      // close event will schedule reconnect
    });

    socket.on("message", (data) => {
      if (controlWs !== socket) return;
      controlLastSeenAt = Date.now();
      const msg = tryParseControlMessage(data);
      if (msg) {
        markControlReady();
      }
      if (!msg) return;
      if (msg.type === "ping") {
        try {
          socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } catch {
          // ignore
        }
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "sync") {
        for (const clientConnectionId of msg.connectionIds) {
          ensureClientDataSocket(clientConnectionId);
        }
        return;
      }
      if (msg.type === "connected") {
        ensureClientDataSocket(msg.connectionId);
        return;
      }
      if (msg.type === "disconnected") {
        const existing = dataSockets.get(msg.connectionId);
        if (existing) {
          try {
            existing.close(1001, "Client disconnected");
          } catch {
            // ignore
          }
          dataSockets.delete(msg.connectionId);
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

  const ensureClientDataSocket = (connectionId: string): void => {
    if (stopped) return;
    if (!connectionId) return;
    if (dataSockets.has(connectionId)) return;

    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls: relayUseTls,
      serverId,
      role: "server",
      connectionId,
    });
    const socket = createWebSocket(url);
    dataSockets.set(connectionId, socket);

    let attached = false;
    const openTimeout = setTimeout(() => {
      if (stopped) return;
      if (socket.readyState === WebSocket.OPEN) return;
      relayLogger.warn({ connectionId }, "relay_data_open_timeout_terminating");
      try {
        socket.terminate();
      } catch {
        // ignore
      }
    }, 15_000);

    socket.on("open", () => {
      clearTimeout(openTimeout);
      relayLogger.info({ connectionId }, "relay_data_connected");
      if (attached) return;
      attached = true;
      const externalMetadata: ExternalSocketMetadata = {
        transport: "relay",
        externalSessionKey: `session:${connectionId}`,
      };
      if (daemonKeyPair) {
        void attachEncryptedSocket(
          socket,
          daemonKeyPair,
          relayLogger.child({ connectionId }),
          attachSocket,
          externalMetadata,
        );
      } else {
        void attachSocket(socket, externalMetadata);
      }
    });

    socket.on("close", (code, reason) => {
      clearTimeout(openTimeout);
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, connectionId },
        "relay_data_disconnected",
      );
      if (dataSockets.get(connectionId) === socket) {
        dataSockets.delete(connectionId);
      }
    });

    socket.on("error", (err) => {
      relayLogger.warn({ err, connectionId }, "relay_data_error");
    });
  };

  connectControl();

  return { stop };
}

async function attachEncryptedSocket(
  socket: RelayWebSocketLike,
  daemonKeyPair: KeyPair,
  logger: pino.Logger,
  attachSocket: (ws: RelaySocketLike, metadata?: ExternalSocketMetadata) => Promise<void>,
  metadata?: ExternalSocketMetadata,
): Promise<void> {
  try {
    const relayTransport = createRelayTransportAdapter(socket, logger);
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
    await attachSocket(encryptedSocket, metadata);
  } catch (error) {
    logger.warn({ err: error }, "relay_e2ee_handshake_failed");
    try {
      socket.close(1011, "E2EE handshake failed");
    } catch {
      // ignore
    }
  }
}

function createRelayTransportAdapter(
  socket: RelayWebSocketLike,
  logger: pino.Logger,
): RelayTransport {
  const relayTransport: RelayTransport = {
    send: (data) => {
      try {
        socket.send(data);
      } catch (err) {
        // Socket likely transitioned to closed between checks; let onclose/onerror
        // drive cleanup. Without this guard the synchronous throw would propagate
        // up as an uncaughtException and take down the daemon.
        logger.warn({ err }, "relay_socket_send_failed");
      }
    },
    close: (code?: number, reason?: string) => socket.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  socket.on("message", (data, isBinary) => {
    relayTransport.onmessage?.(normalizeMessageData(data, isBinary === true));
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

function createEncryptedSocket(channel: EncryptedChannel, emitter: EventEmitter): RelaySocketLike {
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
      const outbound = normalizeRelaySendPayload(data);
      void channel.send(outbound).catch((error) => {
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
