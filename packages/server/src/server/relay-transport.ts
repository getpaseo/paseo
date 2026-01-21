import WebSocket from "ws";
import type pino from "pino";

type RelayTransportOptions = {
  logger: pino.Logger;
  attachSocket: (ws: WebSocket) => Promise<void>;
  relayEndpoint: string; // "host:port"
  sessionId: string;
};

export type RelayTransportController = {
  stop: () => Promise<void>;
};

export function startRelayTransport({
  logger,
  attachSocket,
  relayEndpoint,
  sessionId,
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
      void attachSocket(socket);
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
