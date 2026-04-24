/// <reference lib="dom" />

import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  CURRENT_RELAY_VERSION,
  LEGACY_RELAY_VERSION,
  type RelayProtocolVersion,
  resolveRelayVersion,
} from "./relay-version.js";
import { tryParseRelayControlMessage } from "./relay-control.js";
import type { ConnectionRole, RelaySessionAttachment } from "./types.js";

type RelayFrame = string | Buffer | ArrayBuffer;

const CONTROL_INITIAL_DELAY_MS = 10_000;
const CONTROL_SECOND_DELAY_MS = 5_000;
const PENDING_FRAME_LIMIT = 200;

type NodeRelayServerOptions = {
  host?: string;
  port?: number;
  createConnectionId?: () => string;
};

export type NodeRelayServer = {
  host: string;
  port: number;
  server: HttpServer;
  close(): Promise<void>;
};

class RelaySession {
  readonly version: RelayProtocolVersion;
  readonly serverId: string;
  private readonly createConnectionId: () => string;

  private v1Server: WebSocket | null = null;
  private v1Clients = new Set<WebSocket>();

  private serverControl: WebSocket | null = null;
  private serverDataSockets = new Map<string, WebSocket>();
  private clientSockets = new Map<string, Set<WebSocket>>();
  private pendingFrames = new Map<string, RelayFrame[]>();

  constructor(version: RelayProtocolVersion, serverId: string, createConnectionId: () => string) {
    this.version = version;
    this.serverId = serverId;
    this.createConnectionId = createConnectionId;
  }

  isEmpty(): boolean {
    if (this.version === LEGACY_RELAY_VERSION) {
      return this.v1Server == null && this.v1Clients.size === 0;
    }

    return (
      this.serverControl == null &&
      this.serverDataSockets.size === 0 &&
      this.clientSockets.size === 0 &&
      this.pendingFrames.size === 0
    );
  }

  closeAll(): void {
    if (this.v1Server) {
      try {
        this.v1Server.close();
      } catch {
        // ignore
      }
      this.v1Server = null;
    }

    for (const ws of this.v1Clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.v1Clients.clear();

    if (this.serverControl) {
      try {
        this.serverControl.close();
      } catch {
        // ignore
      }
      this.serverControl = null;
    }

    for (const ws of this.serverDataSockets.values()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.serverDataSockets.clear();

    for (const sockets of this.clientSockets.values()) {
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }
    this.clientSockets.clear();
    this.pendingFrames.clear();
  }

  attachSocket(attachment: RelaySessionAttachment, ws: WebSocket): RelaySessionAttachment {
    if (attachment.version === LEGACY_RELAY_VERSION) {
      this.attachV1Socket(attachment.role, ws);
      return attachment;
    }

    return this.attachV2Socket(attachment, ws);
  }

  handleMessage(attachment: RelaySessionAttachment, ws: WebSocket, message: RelayFrame): void {
    if (attachment.version === LEGACY_RELAY_VERSION) {
      this.handleV1Message(attachment.role, message);
      return;
    }

    this.handleV2Message(attachment, ws, message);
  }

  handleClose(attachment: RelaySessionAttachment, ws: WebSocket): void {
    if (attachment.version === LEGACY_RELAY_VERSION) {
      if (attachment.role === "server") {
        if (this.v1Server === ws) {
          this.v1Server = null;
        }
        return;
      }

      this.v1Clients.delete(ws);
      return;
    }

    if (attachment.role === "client" && attachment.connectionId) {
      const sockets = this.clientSockets.get(attachment.connectionId);
      sockets?.delete(ws);
      if (sockets && sockets.size === 0) {
        this.clientSockets.delete(attachment.connectionId);
        this.pendingFrames.delete(attachment.connectionId);

        const serverData = this.serverDataSockets.get(attachment.connectionId);
        if (serverData) {
          this.serverDataSockets.delete(attachment.connectionId);
          try {
            serverData.close(1001, "Client disconnected");
          } catch {
            // ignore
          }
        }

        this.notifyControl({
          type: "disconnected",
          connectionId: attachment.connectionId,
        });
      }
      return;
    }

    if (attachment.role === "server" && !attachment.connectionId) {
      if (this.serverControl === ws) {
        this.serverControl = null;
      }
      return;
    }

    if (attachment.role === "server" && attachment.connectionId) {
      if (this.serverDataSockets.get(attachment.connectionId) === ws) {
        this.serverDataSockets.delete(attachment.connectionId);
      }
      const sockets = this.clientSockets.get(attachment.connectionId);
      if (!sockets) return;
      for (const clientWs of sockets) {
        try {
          clientWs.close(1012, "Server disconnected");
        } catch {
          // ignore
        }
      }
    }
  }

  private attachV1Socket(role: ConnectionRole, ws: WebSocket): void {
    if (role === "server") {
      if (this.v1Server) {
        try {
          this.v1Server.close(1008, "Replaced by new connection");
        } catch {
          // ignore
        }
      }
      this.v1Server = ws;
      return;
    }

    for (const clientWs of this.v1Clients) {
      try {
        clientWs.close(1008, "Replaced by new connection");
      } catch {
        // ignore
      }
    }
    this.v1Clients.clear();
    this.v1Clients.add(ws);
  }

  private attachV2Socket(
    attachment: RelaySessionAttachment,
    ws: WebSocket,
  ): RelaySessionAttachment {
    if (attachment.role === "client") {
      const resolvedConnectionId = attachment.connectionId || this.createConnectionId();
      const sockets = this.clientSockets.get(resolvedConnectionId) ?? new Set<WebSocket>();
      sockets.add(ws);
      this.clientSockets.set(resolvedConnectionId, sockets);

      const resolvedAttachment: RelaySessionAttachment = {
        ...attachment,
        connectionId: resolvedConnectionId,
      };

      this.notifyControl({ type: "connected", connectionId: resolvedConnectionId });
      this.nudgeOrResetControlForConnection(resolvedConnectionId);
      return resolvedAttachment;
    }

    if (!attachment.connectionId) {
      if (this.serverControl) {
        try {
          this.serverControl.close(1008, "Replaced by new connection");
        } catch {
          // ignore
        }
      }
      this.serverControl = ws;
      this.sendToSocket(ws, {
        type: "sync",
        connectionIds: this.listConnectedConnectionIds(),
      });
      return attachment;
    }

    const existing = this.serverDataSockets.get(attachment.connectionId);
    if (existing) {
      try {
        existing.close(1008, "Replaced by new connection");
      } catch {
        // ignore
      }
    }
    this.serverDataSockets.set(attachment.connectionId, ws);
    this.flushFrames(attachment.connectionId, ws);
    return attachment;
  }

  private handleV1Message(role: ConnectionRole, message: RelayFrame): void {
    if (role === "server") {
      for (const clientWs of this.v1Clients) {
        this.sendFrame(clientWs, message);
      }
      return;
    }

    if (this.v1Server) {
      this.sendFrame(this.v1Server, message);
    }
  }

  private handleV2Message(
    attachment: RelaySessionAttachment,
    ws: WebSocket,
    message: RelayFrame,
  ): void {
    if (!attachment.connectionId) {
      const parsed = tryParseRelayControlMessage(message);
      if (parsed?.type === "ping") {
        this.sendToSocket(ws, { type: "pong" });
      }
      return;
    }

    if (attachment.role === "client") {
      const serverData = this.serverDataSockets.get(attachment.connectionId);
      if (!serverData) {
        this.bufferFrame(attachment.connectionId, message);
        return;
      }
      this.sendFrame(serverData, message);
      return;
    }

    const sockets = this.clientSockets.get(attachment.connectionId);
    if (!sockets) return;
    for (const clientWs of sockets) {
      this.sendFrame(clientWs, message);
    }
  }

  private notifyControl(message: unknown): void {
    if (!this.serverControl) return;
    try {
      this.serverControl.send(JSON.stringify(message));
    } catch {
      try {
        this.serverControl.close(1011, "Control send failed");
      } catch {
        // ignore
      }
    }
  }

  private sendToSocket(ws: WebSocket, message: unknown): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // ignore
    }
  }

  private sendFrame(ws: WebSocket, message: RelayFrame): void {
    try {
      ws.send(message);
    } catch {
      // ignore
    }
  }

  private bufferFrame(connectionId: string, message: RelayFrame): void {
    const frames = this.pendingFrames.get(connectionId) ?? [];
    frames.push(message);
    if (frames.length > PENDING_FRAME_LIMIT) {
      frames.splice(0, frames.length - PENDING_FRAME_LIMIT);
    }
    this.pendingFrames.set(connectionId, frames);
  }

  private flushFrames(connectionId: string, ws: WebSocket): void {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) return;

    this.pendingFrames.delete(connectionId);
    for (const frame of frames) {
      try {
        ws.send(frame);
      } catch {
        this.bufferFrame(connectionId, frame);
        break;
      }
    }
  }

  private listConnectedConnectionIds(): string[] {
    return Array.from(this.clientSockets.entries())
      .filter(([, sockets]) => sockets.size > 0)
      .map(([connectionId]) => connectionId);
  }

  private hasClientSocket(connectionId: string): boolean {
    return (this.clientSockets.get(connectionId)?.size ?? 0) > 0;
  }

  private hasServerDataSocket(connectionId: string): boolean {
    return this.serverDataSockets.has(connectionId);
  }

  private nudgeOrResetControlForConnection(connectionId: string): void {
    setTimeout(() => {
      if (!this.hasClientSocket(connectionId)) return;
      if (this.hasServerDataSocket(connectionId)) return;

      this.notifyControl({ type: "sync", connectionIds: this.listConnectedConnectionIds() });

      setTimeout(() => {
        if (!this.hasClientSocket(connectionId)) return;
        if (this.hasServerDataSocket(connectionId)) return;
        if (!this.serverControl) return;

        try {
          this.serverControl.close(1011, "Control unresponsive");
        } catch {
          // ignore
        }
      }, CONTROL_SECOND_DELAY_MS);
    }, CONTROL_INITIAL_DELAY_MS);
  }
}

function makeAttachment(args: {
  version: RelayProtocolVersion;
  serverId: string;
  role: ConnectionRole;
  connectionId?: string | null;
}): RelaySessionAttachment {
  return {
    serverId: args.serverId,
    role: args.role,
    version: args.version,
    connectionId: args.connectionId ?? null,
    createdAt: Date.now(),
  };
}

function writeUpgradeError(
  socket: {
    write(chunk: string): void;
    destroy(): void;
  },
  statusCode: number,
  statusText: string,
  body: string,
): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
      "\r\n" +
      body,
  );
  socket.destroy();
}

function getSearchParam(url: URL, name: string): string {
  return (url.searchParams.get(name) ?? "").trim();
}

export async function createNodeRelayServer(
  options: NodeRelayServerOptions = {},
): Promise<NodeRelayServer> {
  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 8787;
  const createConnectionId =
    options.createConnectionId ?? (() => `conn_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
  const sessions = new Map<RelayProtocolVersion, Map<string, RelaySession>>([
    [LEGACY_RELAY_VERSION, new Map()],
    [CURRENT_RELAY_VERSION, new Map()],
  ]);
  const attachments = new WeakMap<WebSocket, RelaySessionAttachment>();

  const getOrCreateSession = (version: RelayProtocolVersion, serverId: string): RelaySession => {
    const versionSessions = sessions.get(version)!;
    const existing = versionSessions.get(serverId);
    if (existing) return existing;
    const session = new RelaySession(version, serverId, createConnectionId);
    versionSessions.set(serverId, session);
    return session;
  };

  const cleanupSession = (attachment: RelaySessionAttachment): void => {
    const versionSessions = sessions.get(attachment.version ?? LEGACY_RELAY_VERSION);
    if (!versionSessions) return;
    const session = versionSessions.get(attachment.serverId);
    if (!session) return;
    if (!session.isEmpty()) return;
    versionSessions.delete(attachment.serverId);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname === "/ws") {
      res.statusCode = 426;
      res.end("Expected WebSocket upgrade");
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      writeUpgradeError(socket, 404, "Not Found", "Not found");
      return;
    }

    const role = getSearchParam(url, "role") as ConnectionRole;
    const serverId = getSearchParam(url, "serverId");
    const connectionId = getSearchParam(url, "connectionId");
    const version = resolveRelayVersion(url.searchParams.get("v"));

    if (!role || (role !== "server" && role !== "client")) {
      writeUpgradeError(socket, 400, "Bad Request", "Missing or invalid role parameter");
      return;
    }

    if (!serverId) {
      writeUpgradeError(socket, 400, "Bad Request", "Missing serverId parameter");
      return;
    }

    if (!version) {
      writeUpgradeError(socket, 400, "Bad Request", "Invalid v parameter (expected 1 or 2)");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = getOrCreateSession(version, serverId);

      try {
        const attached = session.attachSocket(
          makeAttachment({
            version,
            serverId,
            role,
            connectionId: connectionId || null,
          }),
          ws,
        );

        attachments.set(ws, attached);

        ws.on("message", (data) => {
          const attachment = attachments.get(ws);
          if (!attachment) return;
          session.handleMessage(attachment, ws, data as RelayFrame);
        });

        ws.on("close", () => {
          const attachment = attachments.get(ws);
          if (!attachment) return;
          session.handleClose(attachment, ws);
          cleanupSession(attachment);
        });

        ws.on("error", () => {
          // Ignore socket-level errors. Cleanup happens on close.
        });
      } catch {
        if (session.isEmpty()) {
          sessions.get(version)?.delete(serverId);
        }
        try {
          ws.close(1011, "Relay attach failed");
        } catch {
          ws.terminate();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve relay server address");
  }

  return {
    host,
    port: address.port,
    server,
    close: async () => {
      for (const versionSessions of sessions.values()) {
        for (const session of versionSessions.values()) {
          session.closeAll();
        }
        versionSessions.clear();
      }

      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      });
    },
  };
}
