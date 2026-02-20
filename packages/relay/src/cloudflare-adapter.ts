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

type RelayProtocolVersion = "1" | "2";

const LEGACY_RELAY_VERSION: RelayProtocolVersion = "1";
const CURRENT_RELAY_VERSION: RelayProtocolVersion = "2";

function resolveRelayVersion(rawValue: string | null): RelayProtocolVersion | null {
  if (rawValue == null) return LEGACY_RELAY_VERSION;
  const value = rawValue.trim();
  if (!value) return LEGACY_RELAY_VERSION;
  if (value === LEGACY_RELAY_VERSION || value === CURRENT_RELAY_VERSION) {
    return value;
  }
  return null;
}

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
 * v1 WebSockets connect in two shapes:
 * - role=server: daemon socket
 * - role=client: app/client socket
 *
 * v2 WebSockets connect in three shapes:
 * - role=server (no clientId): daemon control socket (one per serverId)
 * - role=server&clientId=...: daemon per-client data socket (one per clientId)
 * - role=client&clientId=...: app/client socket (many per clientId)
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

  private createWebSocketPair(): [WebSocket, WebSocket] {
    const pair = new (globalThis as unknown as { WebSocketPair: new () => WebSocketPair }).WebSocketPair();
    return [pair[0], pair[1]];
  }

  private requireWebSocketUpgrade(request: Request): Response | null {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    return null;
  }

  private asSwitchingProtocolsResponse(client: WebSocket): Response {
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as CFResponseInit);
  }

  private hasServerDataSocket(clientId: string): boolean {
    try {
      return this.state.getWebSockets(`server:${clientId}`).length > 0;
    } catch {
      return false;
    }
  }

  private hasClientSocket(clientId: string): boolean {
    try {
      return this.state.getWebSockets(`client:${clientId}`).length > 0;
    } catch {
      return false;
    }
  }

  private nudgeOrResetControlForClient(clientId: string): void {
    // If the daemon's control WS becomes half-open, the DO can't reliably detect it via ws.send errors
    // (Cloudflare may accept writes even if the other side is no longer reading).
    //
    // Instead, observe whether the daemon reacts by opening the per-client server-data socket.
    // If it doesn't, nudge with a sync message; if still no reaction, force-close the control
    // socket(s) so the daemon reconnects.
    const initialDelayMs = 10_000;
    const secondDelayMs = 5_000;

    setTimeout(() => {
      if (!this.hasClientSocket(clientId)) return;
      if (this.hasServerDataSocket(clientId)) return;

      // First nudge: send a full sync list.
      this.notifyControls({ type: "sync", clientIds: this.listConnectedClientIds() });

      setTimeout(() => {
        if (!this.hasClientSocket(clientId)) return;
        if (this.hasServerDataSocket(clientId)) return;

        // Still nothing: assume control is stuck and force a reconnect.
        for (const ws of this.state.getWebSockets("server-control")) {
          try {
            ws.close(1011, "Control unresponsive");
          } catch {
            // ignore
          }
        }
      }, secondDelayMs);
    }, initialDelayMs);
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

  private fetchV1(request: Request, role: ConnectionRole, serverId: string): Response {
    const upgradeError = this.requireWebSocketUpgrade(request);
    if (upgradeError) return upgradeError;

    for (const ws of this.state.getWebSockets(role)) {
      ws.close(1008, "Replaced by new connection");
    }

    const [client, server] = this.createWebSocketPair();
    this.state.acceptWebSocket(server, [role]);

    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      version: LEGACY_RELAY_VERSION,
      clientId: null,
      createdAt: Date.now(),
    };
    (server as WebSocketWithAttachment).serializeAttachment(attachment);

    console.log(`[Relay DO] v1:${role} connected to session ${serverId}`);

    return this.asSwitchingProtocolsResponse(client);
  }

  private fetchV2(
    request: Request,
    role: ConnectionRole,
    serverId: string,
    clientId: string
  ): Response {
    // Clients must provide a clientId so the daemon can create an independent
    // E2EE channel per client connection.
    if (role === "client" && !clientId) {
      return new Response("Missing clientId parameter", { status: 400 });
    }

    const upgradeError = this.requireWebSocketUpgrade(request);
    if (upgradeError) return upgradeError;

    const isServerControl = role === "server" && !clientId;
    const isServerData = role === "server" && !!clientId;

    // Close any existing server-side connection with the same identity.
    // - server-control: single per serverId
    // - server-data: single per clientId
    // - client: many sockets per clientId are allowed
    if (isServerControl) {
      for (const ws of this.state.getWebSockets("server-control")) {
        ws.close(1008, "Replaced by new connection");
      }
    } else if (isServerData) {
      for (const ws of this.state.getWebSockets(`server:${clientId}`)) {
        ws.close(1008, "Replaced by new connection");
      }
    }

    const [client, server] = this.createWebSocketPair();

    const tags: string[] = [];
    if (role === "client") {
      tags.push("client", `client:${clientId}`);
    } else if (isServerControl) {
      tags.push("server-control");
    } else {
      tags.push("server", `server:${clientId}`);
    }

    this.state.acceptWebSocket(server, tags);

    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      version: CURRENT_RELAY_VERSION,
      clientId: clientId || null,
      createdAt: Date.now(),
    };
    (server as WebSocketWithAttachment).serializeAttachment(attachment);

    console.log(
      `[Relay DO] v2:${role}${isServerControl ? "(control)" : ""}${isServerData ? `(data:${clientId})` : role === "client" ? `(${clientId})` : ""} connected to session ${serverId}`
    );

    if (role === "client") {
      this.notifyControls({ type: "client_connected", clientId });
      this.nudgeOrResetControlForClient(clientId);
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

    return this.asSwitchingProtocolsResponse(client);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as ConnectionRole | null;
    const serverId = url.searchParams.get("serverId");
    const clientIdRaw = url.searchParams.get("clientId");
    const clientId = typeof clientIdRaw === "string" ? clientIdRaw.trim() : "";
    const version = resolveRelayVersion(url.searchParams.get("v"));

    if (!role || (role !== "server" && role !== "client")) {
      return new Response("Missing or invalid role parameter", { status: 400 });
    }

    if (!serverId) {
      return new Response("Missing serverId parameter", { status: 400 });
    }

    if (!version) {
      return new Response("Invalid v parameter (expected 1 or 2)", { status: 400 });
    }

    if (version === LEGACY_RELAY_VERSION) {
      return this.fetchV1(request, role, serverId);
    }

    return this.fetchV2(request, role, serverId, clientId);
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

    const version = attachment.version ?? LEGACY_RELAY_VERSION;

    if (version === LEGACY_RELAY_VERSION) {
      const targetRole = attachment.role === "server" ? "client" : "server";
      const targets = this.state.getWebSockets(targetRole);
      for (const target of targets) {
        try {
          target.send(message);
        } catch (error) {
          console.error(`[Relay DO] Failed to forward to ${targetRole}:`, error);
        }
      }
      return;
    }

    const { role, clientId } = attachment;
    if (!clientId) {
      // Control channel: support simple app-level keepalive.
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as unknown as { type?: unknown };
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

    const version = attachment.version ?? LEGACY_RELAY_VERSION;
    console.log(
      `[Relay DO] v${version}:${attachment.role}${attachment.clientId ? `(${attachment.clientId})` : ""} disconnected from session ${attachment.serverId} (${code}: ${reason})`
    );

    if (version === LEGACY_RELAY_VERSION) {
      return;
    }

    if (attachment.role === "client" && attachment.clientId) {
      const remainingClientSockets = this.state
        .getWebSockets(`client:${attachment.clientId}`)
        .some((socket) => socket !== ws);
      if (remainingClientSockets) {
        return;
      }

      this.pendingClientFrames.delete(attachment.clientId);
      // Last socket for this session closed: now clean up matching server-data socket.
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

      const version = resolveRelayVersion(url.searchParams.get("v"));
      if (!version) {
        return new Response("Invalid v parameter (expected 1 or 2)", { status: 400 });
      }

      // Route to a version-isolated Durable Object instance.
      const id = env.RELAY.idFromName(`relay-v${version}:${serverId}`);
      const stub = env.RELAY.get(id);

      const normalizedUrl = new URL(request.url);
      normalizedUrl.searchParams.set("v", version);
      const normalizedRequest = new Request(normalizedUrl.toString(), request);
      return stub.fetch(normalizedRequest);
    }

    return new Response("Not found", { status: 404 });
  },
};
