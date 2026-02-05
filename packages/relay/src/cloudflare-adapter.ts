/**
 * Cloudflare Durable Objects adapter for the relay.
 *
 * This module provides a Durable Object class that can be deployed to
 * Cloudflare Workers. It uses WebSocket hibernation for cost efficiency.
 *
 * Each session gets its own Durable Object instance, identified by session ID.
 *
 * Wrangler config:
 * ```jsonc
 * {
 *   "durable_objects": {
 *     "bindings": [{ "name": "RELAY", "class_name": "RelayDurableObject" }]
 *   },
 *   "migrations": [{ "tag": "v1", "new_classes": ["RelayDurableObject"] }]
 * }
 * ```
 */

import type { ConnectionRole, RelaySessionAttachment } from "./types.js";

type WebSocketPair = {
  0: WebSocket;
  1: WebSocket;
};

interface DurableObjectState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

interface WebSocketWithAttachment extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface Env {
  RELAY: DurableObjectNamespace;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * Durable Object that handles WebSocket relay for a single session.
 *
 * WebSockets connect to this DO in three shapes:
 * - role=server (no clientId): daemon control socket (one per serverId)
 * - role=server&clientId=...: daemon per-client data socket (one per clientId)
 * - role=client&clientId=...: app/client socket (one per clientId)
 *
 * Messages are forwarded between the per-client data sockets and their matching
 * client sockets. The DO hibernates when idle.
 */
interface CFResponseInit extends ResponseInit {
  webSocket?: WebSocket;
}

export class RelayDurableObject {
  private state: DurableObjectState;
  private pendingClientFrames = new Map<string, Array<string | ArrayBuffer>>();

  constructor(state: DurableObjectState) {
    this.state = state;

  }

  private bufferClientFrame(clientId: string, message: string | ArrayBuffer): void {
    const existing = this.pendingClientFrames.get(clientId) ?? [];
    existing.push(message);
    // Prevent unbounded memory growth if a daemon never connects.
    if (existing.length > 200) {
      existing.splice(0, existing.length - 200);
    }
    this.pendingClientFrames.set(clientId, existing);
  }

  private flushClientFrames(clientId: string, serverWs: WebSocket): void {
    const frames = this.pendingClientFrames.get(clientId);
    if (!frames || frames.length === 0) return;
    this.pendingClientFrames.delete(clientId);
    for (const frame of frames) {
      try {
        serverWs.send(frame);
      } catch {
        // If we can't flush, re-buffer and let the daemon re-establish.
        this.bufferClientFrame(clientId, frame);
        break;
      }
    }
  }

  private listConnectedClientIds(): string[] {
    const out = new Set<string>();
    for (const ws of this.state.getWebSockets("client")) {
      try {
        const attachment = (ws as WebSocketWithAttachment).deserializeAttachment() as RelaySessionAttachment | null;
        if (attachment?.role === "client" && typeof attachment.clientId === "string" && attachment.clientId) {
          out.add(attachment.clientId);
        }
      } catch {
        // ignore
      }
    }
    return Array.from(out);
  }

  private notifyControls(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.state.getWebSockets("server-control")) {
      try {
        ws.send(text);
      } catch {
        // If the control socket is dead, close it so the daemon can reconnect.
        try {
          ws.close(1011, "Control send failed");
        } catch {
          // ignore
        }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as ConnectionRole | null;
    const serverId = url.searchParams.get("serverId");
    const clientIdRaw = url.searchParams.get("clientId");
    const clientId = typeof clientIdRaw === "string" ? clientIdRaw.trim() : "";

    if (!role || (role !== "server" && role !== "client")) {
      return new Response("Missing or invalid role parameter", { status: 400 });
    }

    if (!serverId) {
      return new Response("Missing serverId parameter", { status: 400 });
    }

    // Clients must provide a clientId so the daemon can create an independent
    // E2EE channel per client connection.
    if (role === "client" && !clientId) {
      return new Response("Missing clientId parameter", { status: 400 });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const isServerControl = role === "server" && !clientId;
    const isServerData = role === "server" && !!clientId;

    // Close any existing connection with the same identity.
    // - server-control: single per serverId
    // - server-data: single per clientId
    // - client: single per clientId
    if (isServerControl) {
      for (const ws of this.state.getWebSockets("server-control")) {
        ws.close(1008, "Replaced by new connection");
      }
    } else if (isServerData) {
      for (const ws of this.state.getWebSockets(`server:${clientId}`)) {
        ws.close(1008, "Replaced by new connection");
      }
    } else {
      for (const ws of this.state.getWebSockets(`client:${clientId}`)) {
        ws.close(1008, "Replaced by new connection");
      }
    }

    // Create WebSocket pair
    const pair = new (globalThis as unknown as { WebSocketPair: new () => WebSocketPair }).WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const tags: string[] = [];
    if (role === "client") {
      tags.push("client", `client:${clientId}`);
    } else if (isServerControl) {
      tags.push("server-control");
    } else {
      tags.push("server", `server:${clientId}`);
    }

    // Accept with hibernation support, tagged for lookup.
    this.state.acceptWebSocket(server, tags);

    // Store attachment for hibernation recovery
    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      clientId: clientId || null,
      createdAt: Date.now(),
    };
    (server as WebSocketWithAttachment).serializeAttachment(attachment);

    console.log(
      `[Relay DO] ${role}${isServerControl ? "(control)" : ""}${isServerData ? `(data:${clientId})` : role === "client" ? `(${clientId})` : ""} connected to session ${serverId}`
    );

    if (role === "client") {
      this.notifyControls({ type: "client_connected", clientId });
    }

    if (isServerControl) {
      // Send current client list so the daemon can attach existing clients.
      try {
        server.send(JSON.stringify({ type: "sync", clientIds: this.listConnectedClientIds() }));
      } catch {
        // ignore
      }
    }

    if (isServerData && clientId) {
      this.flushClientFrames(clientId, server);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as CFResponseInit);
  }

  /**
   * Called when a WebSocket message is received (wakes from hibernation).
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const attachment = (ws as WebSocketWithAttachment).deserializeAttachment() as RelaySessionAttachment | null;
    if (!attachment) {
      console.error("[Relay DO] Message from WebSocket without attachment");
      return;
    }

    const { role, clientId } = attachment;
    if (!clientId) {
      // Control channel: support simple app-level keepalive.
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as any;
          if (parsed?.type === "ping") {
            try {
              ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore non-JSON control payloads
        }
      }
      return;
    }

    if (role === "client") {
      const servers = this.state.getWebSockets(`server:${clientId}`);
      if (servers.length === 0) {
        this.bufferClientFrame(clientId, message);
        return;
      }
      for (const target of servers) {
        try {
          target.send(message);
        } catch (error) {
          console.error(`[Relay DO] Failed to forward client->server(${clientId}):`, error);
        }
      }
      return;
    }

    // server data socket -> client
    const targets = this.state.getWebSockets(`client:${clientId}`);
    for (const target of targets) {
      try {
        target.send(message);
      } catch (error) {
        console.error(`[Relay DO] Failed to forward server->client(${clientId}):`, error);
      }
    }
  }

  /**
   * Called when a WebSocket closes (wakes from hibernation).
   */
  webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): void {
    const attachment = (ws as WebSocketWithAttachment).deserializeAttachment() as RelaySessionAttachment | null;
    if (!attachment) return;

    console.log(
      `[Relay DO] ${attachment.role}${attachment.clientId ? `(${attachment.clientId})` : ""} disconnected from session ${attachment.serverId} (${code}: ${reason})`
    );

    if (attachment.role === "client" && attachment.clientId) {
      this.pendingClientFrames.delete(attachment.clientId);
      // Close the matching server-data socket so the daemon can clean up quickly.
      for (const serverWs of this.state.getWebSockets(`server:${attachment.clientId}`)) {
        try {
          serverWs.close(1001, "Client disconnected");
        } catch {
          // ignore
        }
      }
      this.notifyControls({ type: "client_disconnected", clientId: attachment.clientId });
      return;
    }

    if (attachment.role === "server" && attachment.clientId) {
      // Force the client to reconnect and re-handshake when the daemon side drops.
      for (const clientWs of this.state.getWebSockets(`client:${attachment.clientId}`)) {
        try {
          clientWs.close(1012, "Server disconnected");
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Called on WebSocket error.
   */
  webSocketError(ws: WebSocket, error: unknown): void {
    const attachment = (ws as WebSocketWithAttachment).deserializeAttachment() as RelaySessionAttachment | null;
    console.error(
      `[Relay DO] WebSocket error for ${attachment?.role ?? "unknown"}:`,
      error
    );
  }
}

/**
 * Worker entry point that routes requests to the appropriate Durable Object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Relay endpoint
    if (url.pathname === "/ws") {
      const serverId = url.searchParams.get("serverId");
      if (!serverId) {
        return new Response("Missing serverId parameter", { status: 400 });
      }

      // Route to Durable Object instance for this session
      const id = env.RELAY.idFromName(serverId);
      const stub = env.RELAY.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
