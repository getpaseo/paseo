import http from "http";
import type { Socket } from "net";
import { WebSocketServer, WebSocket as NodeWebSocket } from "ws";
import type { ConnectionRole } from "./types.js";

export interface NodeRelayServerConfig {
  port: number;
  host?: string;
}

/**
 * Standalone Node.js relay server for self-hosting.
 *
 * v2 protocol:
 * - Daemon connects a single control socket:
 *   ws://host:port/ws?serverId=abc&role=server
 * - Each app client connects with a clientId:
 *   ws://host:port/ws?serverId=abc&role=client&clientId=clt_...
 * - For every connected clientId, the daemon opens a dedicated server-data socket:
 *   ws://host:port/ws?serverId=abc&role=server&clientId=clt_...
 *
 * This allows multiple independent clients, each with its own E2EE handshake.
 */
export interface RelayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type Session = {
  serverId: string;
  control: NodeWebSocket | null;
  clients: Map<string, Set<NodeWebSocket>>; // clientId -> sockets
  servers: Map<string, NodeWebSocket>; // clientId -> server-data socket
  pending: Map<string, Array<string | ArrayBuffer>>; // clientId -> buffered frames
};

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

function normalizeWsMessage(data: unknown, isBinary: boolean): string | ArrayBuffer {
  if (!isBinary) {
    if (typeof data === "string") return data;
    return bufferFromWsData(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) return data;
  const buffer = bufferFromWsData(data);
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out.buffer;
}

export function createRelayServer(config: NodeRelayServerConfig): RelayServer {
  const { port, host = "0.0.0.0" } = config;
  const logFrames = process.env.PASEO_RELAY_LOG_FRAMES === "1";
  const logUpgrades = process.env.PASEO_RELAY_LOG_UPGRADES === "1";

  const sessions = new Map<string, Session>();

  const getSession = (serverId: string): Session => {
    let session = sessions.get(serverId);
    if (!session) {
      session = {
        serverId,
        control: null,
        clients: new Map(),
        servers: new Map(),
        pending: new Map(),
      };
      sessions.set(serverId, session);
      console.log(`[Relay] Session created: ${serverId}`);
    }
    return session;
  };

  const notifyControl = (session: Session, msg: unknown) => {
    if (!session.control || session.control.readyState !== NodeWebSocket.OPEN) return;
    try {
      session.control.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  };

  const listClientIds = (session: Session): string[] => Array.from(session.clients.keys());

  const bufferFrame = (session: Session, clientId: string, frame: string | ArrayBuffer) => {
    const existing = session.pending.get(clientId) ?? [];
    existing.push(frame);
    if (existing.length > 200) existing.splice(0, existing.length - 200);
    session.pending.set(clientId, existing);
  };

  const flushFrames = (session: Session, clientId: string) => {
    const server = session.servers.get(clientId);
    if (!server || server.readyState !== NodeWebSocket.OPEN) return;
    const frames = session.pending.get(clientId);
    if (!frames || frames.length === 0) return;
    session.pending.delete(clientId);
    for (const frame of frames) {
      try {
        server.send(frame);
      } catch {
        bufferFrame(session, clientId, frame);
        break;
      }
    }
  };

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

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
      const clientId = (url.searchParams.get("clientId") ?? "").trim();
      if (!serverId || !role || (role !== "server" && role !== "client")) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      if (role === "client" && !clientId) {
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
    const clientId = (url.searchParams.get("clientId") ?? "").trim();
    const session = getSession(serverId);

    const isControl = role === "server" && !clientId;
    const isServerData = role === "server" && !!clientId;

    if (isControl) {
      try {
        session.control?.close(1008, "Replaced by new connection");
      } catch {
        // ignore
      }
      session.control = ws;
      try {
        ws.send(JSON.stringify({ type: "sync", clientIds: listClientIds(session) }));
      } catch {
        // ignore
      }
    }

    if (role === "client") {
      const set = session.clients.get(clientId) ?? new Set();
      set.add(ws);
      session.clients.set(clientId, set);
      notifyControl(session, { type: "client_connected", clientId });
    }

    if (isServerData) {
      const prev = session.servers.get(clientId);
      if (prev && prev !== ws) {
        try {
          prev.close(1008, "Replaced by new connection");
        } catch {
          // ignore
        }
      }
      session.servers.set(clientId, ws);
      flushFrames(session, clientId);
    }

    ws.on("message", (data, isBinary) => {
      const normalized = normalizeWsMessage(data, isBinary);

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
          `[Relay] frame ${serverId}/${role}${clientId ? `(${clientId})` : ""} binary=${isBinary} len=${len} preview=${JSON.stringify(preview)}`
        );
      }

      if (role === "client") {
        const server = session.servers.get(clientId);
        if (!server || server.readyState !== NodeWebSocket.OPEN) {
          bufferFrame(session, clientId, normalized);
          return;
        }
        try {
          server.send(normalized);
        } catch {
          // ignore
        }
        return;
      }

      if (isServerData) {
        const targets = session.clients.get(clientId);
        if (!targets) return;
        for (const target of targets) {
          if (target.readyState !== NodeWebSocket.OPEN) continue;
          try {
            target.send(normalized);
          } catch {
            // ignore
          }
        }
      }
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf?.toString?.() ?? "";

      if (isControl) {
        if (session.control === ws) session.control = null;
      } else if (role === "client") {
        const set = session.clients.get(clientId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            session.clients.delete(clientId);
            session.pending.delete(clientId);
            const server = session.servers.get(clientId);
            if (server) {
              try {
                server.close(1001, "Client disconnected");
              } catch {
                // ignore
              }
              session.servers.delete(clientId);
            }
            notifyControl(session, { type: "client_disconnected", clientId });
          }
        }
      } else if (isServerData) {
        if (session.servers.get(clientId) === ws) {
          session.servers.delete(clientId);
        }
        const targets = session.clients.get(clientId);
        if (targets) {
          for (const target of targets) {
            try {
              target.close(1012, "Server disconnected");
            } catch {
              // ignore
            }
          }
        }
      }

      if (logUpgrades) {
        console.log(
          `[Relay] close ${serverId}/${role}${clientId ? `(${clientId})` : ""} code=${code} reason=${JSON.stringify(reason)}`
        );
      }

      if (session.control === null && session.clients.size === 0 && session.servers.size === 0) {
        sessions.delete(serverId);
        console.log(`[Relay] Session closed: ${serverId}`);
      }
    });

    ws.on("error", (error) => {
      console.error(`[Relay] WebSocket error for ${serverId}/${role}${clientId ? `(${clientId})` : ""}:`, error);
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
        try {
          httpServer.close(() => undefined);
        } catch {
          // ignore
        }

        for (const ws of wss.clients) {
          try {
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
  };
}

