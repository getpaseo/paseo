/**
 * Node.js WebSocket relay server for Paseo.
 *
 * Implements the same protocol as Cloudflare Durable Objects:
 * - v1: Single server ↔ single client relay (1:1 by serverId)
 * - v2: Control channel + per-connectionId data routing + message buffering
 *
 * Usage:
 *   npx ts-node nodejs-adapter.ts
 *   node dist/nodejs-adapter.js
 *
 * Environment variables:
 *   PORT=8080           WebSocket server port (default: 8080)
 *   HOST=0.0.0.0        Bind address (default: 0.0.0.0)
 *   MAX_BUFFER=200      Max buffered frames per connectionId (default: 200)
 *   LOG_LEVEL=info      pino log level (default: info)
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";

export type ConnectionRole = "server" | "client";

export interface RelaySessionAttachment {
  serverId: string;
  role: ConnectionRole;
  version: "1" | "2";
  connectionId: string | null;
  createdAt: number;
}

type RelayProtocolVersion = "1" | "2";

const LEGACY_RELAY_VERSION: RelayProtocolVersion = "1";
const CURRENT_RELAY_VERSION: RelayProtocolVersion = "2";

const MAX_BUFFER_SIZE = parseInt(process.env.MAX_BUFFER ?? "200", 10);

// ─── Session Storage ────────────────────────────────────────────────────────

interface ConnectionEntry {
  ws: WebSocket;
  attachment: RelaySessionAttachment;
}

interface ConnectionData {
  serverDataSocket: ConnectionEntry | null;
  bufferedFrames: Array<string | ArrayBuffer>;
  clientSockets: ConnectionEntry[];
}

interface SessionState {
  serverControlSocket: ConnectionEntry | null;
  connections: Map<string, ConnectionData>; // connectionId → data
}

const sessions = new Map<string, SessionState>(); // serverId → state

function getOrCreateSession(serverId: string): SessionState {
  let session = sessions.get(serverId);
  if (!session) {
    session = { serverControlSocket: null, connections: new Map() };
    sessions.set(serverId, session);
  }
  return session;
}

function resolveRelayVersion(raw: string | null): RelayProtocolVersion | null {
  if (raw == null) return LEGACY_RELAY_VERSION;
  const value = raw.trim();
  if (!value) return LEGACY_RELAY_VERSION;
  if (value === LEGACY_RELAY_VERSION || value === CURRENT_RELAY_VERSION) {
    return value;
  }
  return null;
}

function parseUrl(url: string): {
  role: ConnectionRole;
  serverId: string;
  connectionId: string;
  version: RelayProtocolVersion;
} | null {
  try {
    const urlObj = new URL(url, "http://localhost");
    const role = urlObj.searchParams.get("role") as ConnectionRole | null;
    const serverId = urlObj.searchParams.get("serverId");
    const connectionIdRaw = urlObj.searchParams.get("connectionId");
    const connectionId = typeof connectionIdRaw === "string" ? connectionIdRaw.trim() : "";
    const version = resolveRelayVersion(urlObj.searchParams.get("v"));

    if (!role || (role !== "server" && role !== "client")) return null;
    if (!serverId) return null;
    if (!version) return null;

    return { role, serverId, connectionId, version };
  } catch {
    return null;
  }
}

function requireWebSocketUpgrade(request: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const upgrade = request.headers["upgrade"];
  if (!upgrade || upgrade.toString().toLowerCase() !== "websocket") {
    return false;
  }
  return true;
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // ignore
  }
}

function sendJson(ws: WebSocket, data: unknown): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch {
    // ignore
  }
}

function listConnectedConnectionIds(session: SessionState): string[] {
  const out: string[] = [];
  for (const [connectionId, data] of session.connections) {
    if (data.clientSockets.length > 0) {
      out.push(connectionId);
    }
  }
  return out;
}

function notifyControls(session: SessionState, message: unknown): void {
  if (!session.serverControlSocket) return;
  try {
    if (session.serverControlSocket.ws.readyState === WebSocket.OPEN) {
      session.serverControlSocket.ws.send(JSON.stringify(message));
    }
  } catch {
    // Control socket dead — close it so daemon reconnects
    if (session.serverControlSocket) {
      closeSocket(session.serverControlSocket.ws, 1011, "Control send failed");
      session.serverControlSocket = null;
    }
  }
}

function bufferFrame(data: ConnectionData, message: string | ArrayBuffer): void {
  data.bufferedFrames.push(message);
  if (data.bufferedFrames.length > MAX_BUFFER_SIZE) {
    data.bufferedFrames.splice(0, data.bufferedFrames.length - MAX_BUFFER_SIZE);
  }
}

function flushFrames(data: ConnectionData, serverWs: WebSocket): void {
  if (data.bufferedFrames.length === 0) return;
  const frames = data.bufferedFrames;
  data.bufferedFrames = [];
  for (const frame of frames) {
    try {
      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(frame);
      } else {
        // Re-buffer if server went away
        data.bufferedFrames.push(frame);
        break;
      }
    } catch {
      data.bufferedFrames.unshift(frame);
      break;
    }
  }
}

// ─── V1 Protocol ────────────────────────────────────────────────────────────

function handleV1(
  session: SessionState,
  role: ConnectionRole,
  serverId: string,
  ws: WebSocket,
): void {
  // Close existing socket of same role — only one per role in v1
  const existing = role === "server" ? session.serverControlSocket : null;

  if (existing) {
    closeSocket(existing.ws, 1008, "Replaced by new connection");
    if (role === "server") session.serverControlSocket = null;
  }

  const entry: ConnectionEntry = {
    ws,
    attachment: {
      serverId,
      role,
      version: LEGACY_RELAY_VERSION,
      connectionId: null,
      createdAt: Date.now(),
    },
  };

  if (role === "server") {
    session.serverControlSocket = entry;
  }

  console.log(`[Relay] v1:${role} connected to session ${serverId}`);

  // If both sides are connected, start relaying
  if (session.serverControlSocket && session.connections.size > 0) {
    // In v1 there's no connectionId concept, but we stored a default entry
    const defaultConn = session.connections.get("");
    if (defaultConn?.clientSockets.length) {
      relayV1(session);
    }
  }
}

function relayV1(session: SessionState): void {
  // v1 simple relay: server ↔ all v1 clients
  // This is a simplified v1 — in practice v1 only ever has one client
  const server = session.serverControlSocket;
  const clients = session.connections.get("")?.clientSockets ?? [];

  for (const client of clients) {
    relayBidirectional(server?.ws, client.ws);
  }
}

function relayBidirectional(a: WebSocket | undefined, b: WebSocket): void {
  if (!a || a.readyState !== WebSocket.OPEN || b.readyState !== WebSocket.OPEN) return;

  const relay = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data) => {
      try {
        if (to.readyState === WebSocket.OPEN) {
          to.send(data);
        }
      } catch (err) {
        console.error("[Relay] Failed to forward message:", err);
      }
    });
  };

  relay(a, b);
  relay(b, a);
}

// ─── V2 Protocol ────────────────────────────────────────────────────────────

function handleV2(
  session: SessionState,
  role: ConnectionRole,
  serverId: string,
  connectionId: string,
  ws: WebSocket,
): void {
  // Resolve connectionId: client without one gets a random ID
  const resolvedConnectionId: string =
    role === "client" && !connectionId
      ? `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      : connectionId;

  const isServerControl = role === "server" && !resolvedConnectionId;
  const isServerData = role === "server" && !!resolvedConnectionId;

  // Close existing server-side socket with same identity
  if (isServerControl) {
    if (session.serverControlSocket) {
      closeSocket(session.serverControlSocket.ws, 1008, "Replaced by new connection");
    }
    session.serverControlSocket = null;
  } else if (isServerData) {
    let conn = session.connections.get(resolvedConnectionId);
    if (!conn) {
      conn = { serverDataSocket: null, bufferedFrames: [], clientSockets: [] };
      session.connections.set(resolvedConnectionId, conn);
    }
    if (conn.serverDataSocket) {
      closeSocket(conn.serverDataSocket.ws, 1008, "Replaced by new connection");
    }
    conn.serverDataSocket = null;
  } else if (role === "client") {
    // Ensure connection entry exists
    let conn = session.connections.get(resolvedConnectionId);
    if (!conn) {
      conn = { serverDataSocket: null, bufferedFrames: [], clientSockets: [] };
      session.connections.set(resolvedConnectionId, conn);
    }
  }

  const attachment: RelaySessionAttachment = {
    serverId,
    role,
    version: CURRENT_RELAY_VERSION,
    connectionId: resolvedConnectionId || null,
    createdAt: Date.now(),
  };

  const entry: ConnectionEntry = { ws, attachment };
  let logTag = `v2:${role}`;
  if (isServerControl) logTag += "(control)";
  else if (isServerData) logTag += `(${resolvedConnectionId})`;
  else logTag += `(${resolvedConnectionId})`;

  console.log(`[Relay] ${logTag} connected to session ${serverId}`);

  if (isServerControl) {
    session.serverControlSocket = entry;
    // Send current connection list so daemon can attach existing connections
    sendJson(ws, { type: "sync", connectionIds: listConnectedConnectionIds(session) });
    return;
  }

  if (isServerData && resolvedConnectionId) {
    const conn = session.connections.get(resolvedConnectionId)!;
    conn.serverDataSocket = entry;
    // Flush buffered frames from clients
    flushFrames(conn, ws);

    // If any client is waiting, notify control
    if (conn.clientSockets.length > 0) {
      notifyControls(session, { type: "connected", connectionId: resolvedConnectionId });
    }

    // Nudge control if no clients connected yet
    if (conn.clientSockets.length === 0) {
      nudgeControl(session, resolvedConnectionId);
    }
    return;
  }

  // Client socket
  if (role === "client" && resolvedConnectionId) {
    const conn = session.connections.get(resolvedConnectionId)!;
    conn.clientSockets.push(entry);

    // Notify control that a client connected
    notifyControls(session, { type: "connected", connectionId: resolvedConnectionId });

    // If server data socket exists, flush buffered messages
    if (conn.serverDataSocket) {
      flushFrames(conn, conn.serverDataSocket.ws);
    } else {
      // Nudge control if no clients connected yet
      nudgeControl(session, resolvedConnectionId);
    }
    return;
  }
}

// Nudge control when a client connects but no server data socket exists yet
const nudgeControl = (() => {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  return (session: SessionState, connectionId: string): void => {
    const existing = pending.get(connectionId);
    if (existing) clearTimeout(existing);

    const t1 = setTimeout(() => {
      const conn = session.connections.get(connectionId);
      if (!conn || conn.clientSockets.length === 0) {
        pending.delete(connectionId);
        return;
      }
      if (conn.serverDataSocket) {
        pending.delete(connectionId);
        return;
      }

      // First nudge: send sync list
      notifyControls(session, { type: "sync", connectionIds: listConnectedConnectionIds(session) });

      const t2 = setTimeout(() => {
        const conn2 = session.connections.get(connectionId);
        if (!conn2 || conn2.clientSockets.length === 0) {
          pending.delete(connectionId);
          return;
        }
        if (conn2.serverDataSocket) {
          pending.delete(connectionId);
          return;
        }

        // Second nudge: still nothing — force control socket reconnect
        if (session.serverControlSocket) {
          closeSocket(session.serverControlSocket.ws, 1011, "Control unresponsive");
          session.serverControlSocket = null;
        }
        pending.delete(connectionId);
      }, 5000);

      pending.set(connectionId, t2);
    }, 10_000);

    pending.set(connectionId, t1);
  };
})();

// ─── Message Handling ───────────────────────────────────────────────────────

function handleMessage(serverId: string, ws: WebSocket, data: string | ArrayBuffer): void {
  const session = sessions.get(serverId);
  if (!session) return;

  // Find the entry by ws
  const attachment = findAttachment(session, ws);
  if (!attachment) return;

  const { role, version, connectionId } = attachment;

  if (version === LEGACY_RELAY_VERSION) {
    // v1: relay to opposite role
    if (role === "server" && session.serverControlSocket) {
      relayToClients(session, "", data);
    }
    return;
  }

  // v2 control channel: support ping
  if (!connectionId && typeof data === "string") {
    try {
      const parsed = JSON.parse(data) as { type?: string };
      if (parsed?.type === "ping") {
        sendJson(ws, { type: "pong", ts: Date.now() });
      }
    } catch {
      // ignore
    }
    return;
  }

  if (!connectionId) return;

  const conn = session.connections.get(connectionId);
  if (!conn) return;

  if (role === "client") {
    // Forward to server data socket
    if (conn.serverDataSocket) {
      try {
        if (conn.serverDataSocket.ws.readyState === WebSocket.OPEN) {
          conn.serverDataSocket.ws.send(data);
        }
      } catch (err) {
        console.error(`[Relay] Forward client→server(${connectionId}) failed:`, err);
      }
    } else {
      // Buffer if server not connected yet
      bufferFrame(conn, data);
    }
    return;
  }

  // server data socket → all clients
  for (const client of conn.clientSockets) {
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    } catch (err) {
      console.error(`[Relay] Forward server→client(${connectionId}) failed:`, err);
    }
  }
}

function findAttachment(session: SessionState, ws: WebSocket): RelaySessionAttachment | null {
  if (session.serverControlSocket?.ws === ws) {
    return session.serverControlSocket.attachment;
  }
  for (const conn of session.connections.values()) {
    if (conn.serverDataSocket?.ws === ws) {
      return conn.serverDataSocket.attachment;
    }
    for (const client of conn.clientSockets) {
      if (client.ws === ws) return client.attachment;
    }
  }
  return null;
}

function relayToClients(
  session: SessionState,
  connectionId: string,
  data: string | ArrayBuffer,
): void {
  const conn = session.connections.get(connectionId);
  if (!conn) return;
  for (const client of conn.clientSockets) {
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    } catch (err) {
      console.error(`[Relay] V1 relay to client failed:`, err);
    }
  }
}

// ─── Close Handling ─────────────────────────────────────────────────────────

function handleClose(serverId: string, ws: WebSocket, code: number, reason: string): void {
  const session = sessions.get(serverId);
  if (!session) return;

  const attachment = findAttachment(session, ws);
  if (!attachment) return;

  const { role, version, connectionId } = attachment;
  console.log(
    `[Relay] v${version}:${role}${connectionId ? `(${connectionId})` : ""} disconnected from session ${serverId} (${code}: ${reason})`,
  );

  if (version === LEGACY_RELAY_VERSION) {
    if (role === "server") {
      session.serverControlSocket = null;
    }
    return;
  }

  if (role === "server") {
    if (!connectionId) {
      // Control socket closed — close all server data sockets to force reconnect
      session.serverControlSocket = null;
      for (const conn of session.connections.values()) {
        if (conn.serverDataSocket) {
          closeSocket(conn.serverDataSocket.ws, 1001, "Control disconnected");
          conn.serverDataSocket = null;
        }
      }
      return;
    }

    // Server data socket closed
    const conn = session.connections.get(connectionId);
    if (!conn) return;
    conn.serverDataSocket = null;

    // Force all clients to reconnect
    for (const client of conn.clientSockets) {
      closeSocket(client.ws, 1012, "Server disconnected");
    }
    conn.clientSockets = [];
    conn.bufferedFrames = [];
    notifyControls(session, { type: "disconnected", connectionId });
    return;
  }

  // Client closed
  if (connectionId) {
    const conn = session.connections.get(connectionId);
    if (!conn) return;

    conn.clientSockets = conn.clientSockets.filter((e) => e.ws !== ws);

    if (conn.clientSockets.length === 0) {
      // Last client closed — clean up server data socket
      conn.bufferedFrames = [];
      if (conn.serverDataSocket) {
        closeSocket(conn.serverDataSocket.ws, 1001, "Client disconnected");
        conn.serverDataSocket = null;
      }
      notifyControls(session, { type: "disconnected", connectionId });
    }
  }
}

// ─── WebSocket Server ───────────────────────────────────────────────────────

export function createRelayServer(port = 8080, host = "0.0.0.0"): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          sessions: sessions.size,
          connections: countConnections(),
          version: "nodejs-adapter-v1",
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (!requireWebSocketUpgrade(request)) {
      socket.destroy();
      return;
    }

    const parsed = parseUrl(request.url ?? "/");
    if (!parsed) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const { role, serverId, connectionId, version } = parsed;
      const session = getOrCreateSession(serverId);

      if (version === LEGACY_RELAY_VERSION) {
        handleV1(session, role, serverId, ws);
      } else {
        handleV2(session, role, serverId, connectionId, ws);
      }

      ws.on("message", (data: Buffer | ArrayBuffer | string) => {
        const normalized: string | ArrayBuffer =
          typeof data === "string" ? data : (new Uint8Array(data as Buffer).buffer as ArrayBuffer);
        handleMessage(serverId, ws, normalized);
      });

      ws.on("close", (code, reason) => {
        handleClose(serverId, ws, code, reason.toString());
        cleanupSession(serverId);
      });

      ws.on("error", (err) => {
        console.error(`[Relay] WebSocket error for ${role}(${connectionId ?? ""}):`, err);
      });
    });
  });

  httpServer.listen(port, host, () => {
    console.log(`[Relay] Listening on ws://${host}:${port}`);
  });

  return wss;
}

function countConnections(): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.serverControlSocket) count++;
    for (const conn of session.connections.values()) {
      if (conn.serverDataSocket) count++;
      count += conn.clientSockets.length;
    }
  }
  return count;
}

function cleanupSession(serverId: string): void {
  const session = sessions.get(serverId);
  if (!session) return;

  const isEmpty =
    !session.serverControlSocket &&
    Array.from(session.connections.values()).every(
      (c) => !c.serverDataSocket && c.clientSockets.length === 0,
    );

  if (isEmpty) {
    sessions.delete(serverId);
    console.log(`[Relay] Session ${serverId} cleaned up`);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

createRelayServer(PORT, HOST);
