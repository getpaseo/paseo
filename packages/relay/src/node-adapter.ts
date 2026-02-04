import http from "http";
import type { Socket } from "net";
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
 * - ws://host:port/ws?serverId=abc&role=server
 * - ws://host:port/ws?serverId=abc&role=client
 */
export interface RelayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getRelay(): Relay;
}

export function createRelayServer(config: NodeRelayServerConfig): RelayServer {
  const { port, host = "0.0.0.0" } = config;
  const logFrames = process.env.PASEO_RELAY_LOG_FRAMES === "1";
  const logUpgrades = process.env.PASEO_RELAY_LOG_UPGRADES === "1";

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

  // NOTE: We intentionally use `noServer` + a manual `upgrade` handler instead
  // of `new WebSocketServer({ server, path })`.
  //
  // In some environments (notably when running via `tsx -e`), we observed
  // websocket upgrade requests falling through to the HTTP handler (404),
  // despite `ws` being configured with `{ server, path: "/ws" }`.
  // Handling `upgrade` explicitly is more robust and easier to debug.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket: Socket, head) => {
    if (logUpgrades) {
      try {
        console.log(
          `[Relay] upgrade url=${JSON.stringify(req.url)} host=${JSON.stringify(req.headers.host)}`
        );
      } catch {
        // ignore
      }
    }
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const serverId = url.searchParams.get("serverId");
      const role = url.searchParams.get("role");
      if (!serverId || !role || (role !== "server" && role !== "client")) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const serverId = url.searchParams.get("serverId")!;
    const role = url.searchParams.get("role") as ConnectionRole;

    const connection = wrapWebSocket(ws, role);
    relay.addConnection(serverId, role, connection);

    ws.on("message", (data, isBinary) => {
      // If this socket was replaced, ignore any late frames.
      if (relay.getSession(serverId)?.[role] !== connection) return;

      if (logFrames) {
        const preview = (() => {
          try {
            if (isBinary) return "<binary>";
            return bufferFromWsData(data).toString("utf8").slice(0, 200);
          } catch {
            return "<unavailable>";
          }
        })();
        const len = (() => {
          try {
            return bufferFromWsData(data).byteLength;
          } catch {
            return -1;
          }
        })();
        console.log(
          `[Relay] frame ${serverId}/${role} binary=${isBinary} len=${len} preview=${JSON.stringify(preview)}`
        );
      }
      relay.forward(serverId, role, normalizeWsMessageForRelay(data, isBinary));
    });

    ws.on("close", () => {
      // Avoid clearing the current connection if this socket was replaced.
      if (relay.getSession(serverId)?.[role] !== connection) return;
      relay.removeConnection(serverId, role);
    });

    ws.on("error", (error) => {
      console.error(`[Relay] WebSocket error for ${serverId}/${role}:`, error);
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
        // Stop accepting new connections immediately. Waiting for `wss.close`
        // can leave the HTTP server listening while the WS server is closing,
        // causing upgrade requests to get 503 responses.
        try {
          httpServer.close(() => undefined);
        } catch {
          // ignore
        }

        // Close active sessions + force-close any remaining clients.
        for (const session of relay.listSessions()) {
          relay.closeSession(session.serverId, 1001, "Server shutting down");
        }
        for (const ws of wss.clients) {
          try {
            // terminate() is the fastest way to ensure `wss.close` completes.
            (ws as unknown as { terminate?: () => void }).terminate?.();
          } catch {
            try {
              ws.close(1001, "Server shutting down");
            } catch {
              // ignore
            }
          }
        }

        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };

        const timeout = setTimeout(() => finish(), 1500);
        try {
          wss.close(() => {
            clearTimeout(timeout);
            finish();
          });
        } catch {
          clearTimeout(timeout);
          finish();
        }
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

function normalizeWsMessageForRelay(data: unknown, isBinary: boolean): string | ArrayBuffer {
  if (isBinary) {
    return normalizeWsBinaryMessage(data);
  }
  return normalizeWsTextMessage(data);
}

function normalizeWsBinaryMessage(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  return bufferToArrayBuffer(bufferFromWsData(data));
}

function normalizeWsTextMessage(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  return bufferFromWsData(data).toString("utf8");
}

function bufferFromWsData(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;

  if (Array.isArray(data)) {
    return Buffer.concat(data.map(bufferFromWsData));
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }

  return Buffer.from(String(data), "utf8");
}
