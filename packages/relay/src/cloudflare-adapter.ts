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
 * Two WebSockets connect to this DO:
 * - role=server: The Paseo daemon
 * - role=client: The mobile/web app
 *
 * Messages are forwarded between them. The DO hibernates when idle.
 */
interface CFResponseInit extends ResponseInit {
  webSocket?: WebSocket;
}

export class RelayDurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;

  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as ConnectionRole | null;
    const sessionId = url.searchParams.get("session");

    if (!role || (role !== "server" && role !== "client")) {
      return new Response("Missing or invalid role parameter", { status: 400 });
    }

    if (!sessionId) {
      return new Response("Missing session parameter", { status: 400 });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Close any existing connection with the same role
    const existingConnections = this.state.getWebSockets(role);
    for (const ws of existingConnections) {
      ws.close(1008, "Replaced by new connection");
    }

    // Create WebSocket pair
    const pair = new (globalThis as unknown as { WebSocketPair: new () => WebSocketPair }).WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept with hibernation support, tagged by role
    this.state.acceptWebSocket(server, [role]);

    // Store attachment for hibernation recovery
    const attachment: RelaySessionAttachment = {
      sessionId,
      role,
      createdAt: Date.now(),
    };
    (server as WebSocketWithAttachment).serializeAttachment(attachment);

    console.log(`[Relay DO] ${role} connected to session ${sessionId}`);

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

    const { role } = attachment;
    const targetRole = role === "server" ? "client" : "server";
    const targets = this.state.getWebSockets(targetRole);

    for (const target of targets) {
      try {
        target.send(message);
      } catch (error) {
        console.error(`[Relay DO] Failed to forward to ${targetRole}:`, error);
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
      `[Relay DO] ${attachment.role} disconnected from session ${attachment.sessionId} (${code}: ${reason})`
    );

    // Note: The other connection remains open.
    // The client/server will detect the peer is gone when they try to send.
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
      const sessionId = url.searchParams.get("session");
      if (!sessionId) {
        return new Response("Missing session parameter", { status: 400 });
      }

      // Route to Durable Object instance for this session
      const id = env.RELAY.idFromName(sessionId);
      const stub = env.RELAY.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
