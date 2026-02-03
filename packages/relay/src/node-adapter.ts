import http from "http";
import { WebSocketServer, WebSocket as NodeWebSocket } from "ws";
import { Relay } from "./relay.js";
import type { ConnectionRole, RelayConnection } from "./types.js";

export interface NodeRelayServerConfig {
  port: number;
  host?: string;
}

/**
 * Standalone Node.js relay server for self-hosting.
 *
 * This is a separate process that bridges daemon↔client connections.
 * Use this when you want to self-host a relay instead of using Cloudflare.
 *
 * Usage:
 * ```ts
 * const server = createRelayServer({ port: 8080 });
 * await server.start();
 * ```
 *
 * Clients connect via:
 * - ws://host:port/ws?session=abc&role=server
 * - ws://host:port/ws?session=abc&role=client
 */
export interface RelayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getRelay(): Relay;
}

export function createRelayServer(config: NodeRelayServerConfig): RelayServer {
  const { port, host = "0.0.0.0" } = config;

  const relay = new Relay({
    onSessionCreated: (id) => console.log(`[Relay] Session created: ${id}`),
    onSessionBridged: (id) => console.log(`[Relay] Session bridged: ${id}`),
    onSessionClosed: (id) => console.log(`[Relay] Session closed: ${id}`),
    onError: (id, err) => console.error(`[Relay] Session ${id} error:`, err),
  });

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    verifyClient: ({ req }, callback) => {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const session = url.searchParams.get("session");
      const role = url.searchParams.get("role");

      if (!session || !role || (role !== "server" && role !== "client")) {
        callback(false, 400, "Missing or invalid session/role parameters");
        return;
      }

      callback(true);
    },
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("session")!;
    const role = url.searchParams.get("role") as ConnectionRole;

    const connection = wrapWebSocket(ws, role);
    relay.addConnection(sessionId, role, connection);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const message =
          data instanceof ArrayBuffer
            ? data
            : bufferToArrayBuffer(
                data instanceof Buffer
                  ? data
                  : ArrayBuffer.isView(data)
                    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
                    : Buffer.from(String(data), "utf8")
              );
        relay.forward(sessionId, role, message);
        return;
      }

      const text =
        typeof data === "string"
          ? data
          : data instanceof Buffer
            ? data.toString("utf8")
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
                : String(data);
      relay.forward(sessionId, role, text);
    });

    ws.on("close", () => {
      relay.removeConnection(sessionId, role);
    });

    ws.on("error", (error) => {
      console.error(`[Relay] WebSocket error for ${sessionId}/${role}:`, error);
    });
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(port, host, () => {
          console.log(`[Relay] Listening on ${host}:${port}`);
          resolve();
        });
      });
    },

    stop() {
      return new Promise((resolve) => {
        for (const session of relay.listSessions()) {
          relay.closeSession(session.id, 1001, "Server shutting down");
        }
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },

    getRelay() {
      return relay;
    },
  };
}

function wrapWebSocket(ws: NodeWebSocket, role: ConnectionRole): RelayConnection {
  return {
    role,
    send: (data) => {
      if (ws.readyState === NodeWebSocket.OPEN) {
        ws.send(data);
      }
    },
    close: (code, reason) => {
      ws.close(code, reason);
    },
  };
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out.buffer;
}
