import type {
  ConnectionRole,
  RelayConnection,
  RelayEvents,
  RelaySession,
} from "./types.js";

/**
 * Core relay logic for bridging server and client WebSocket connections.
 *
 * This class is platform-agnostic and works with any WebSocket implementation
 * that conforms to the RelayConnection interface.
 */
export class Relay {
  private sessions = new Map<string, RelaySession>();
  private events: RelayEvents;

  constructor(events: RelayEvents = {}) {
    this.events = events;
  }

  /**
   * Register a connection for a session.
   * If both server and client are connected, messages are bridged.
   */
  addConnection(
    serverId: string,
    role: ConnectionRole,
    connection: RelayConnection
  ): void {
    let session = this.sessions.get(serverId);

    if (!session) {
      session = {
        serverId,
        server: null,
        client: null,
        createdAt: Date.now(),
      };
      this.sessions.set(serverId, session);
      this.events.onSessionCreated?.(serverId);
    }

    const previousServer = session.server;
    const previousClient = session.client;

    const existingConnection = session[role];
    if (existingConnection) {
      existingConnection.close(1008, "Replaced by new connection");
    }

    session[role] = connection;

    // Important: the E2EE handshake is tied to a specific server↔client socket pair.
    // If the daemon reconnects (server socket changes) while the client socket stays
    // open, the client will continue sending encrypted frames using its existing
    // channel state — but the new daemon socket hasn't handshaked yet. This leads
    // to immediate decrypt/handshake failures.
    //
    // To keep the protocol simple and robust, whenever a new *server* connection
    // arrives while a client socket is still connected, force the client to reconnect.
    if (role === "server" && previousClient) {
      // Only close if the server socket actually changed (or was previously missing).
      const serverChanged = !previousServer || previousServer !== connection;
      if (serverChanged) {
        session.client = null;
        previousClient.close(1012, "Server reconnected");
      }
    }

    if (session.server && session.client) {
      this.events.onSessionBridged?.(serverId);
    }
  }

  /**
   * Remove a connection from a session.
   * If both connections are gone, the session is cleaned up.
   */
  removeConnection(serverId: string, role: ConnectionRole): void {
    const session = this.sessions.get(serverId);
    if (!session) return;

    session[role] = null;

    if (!session.server && !session.client) {
      this.sessions.delete(serverId);
      this.events.onSessionClosed?.(serverId);
    }
  }

  /**
   * Forward a message from one side to the other.
   */
  forward(
    serverId: string,
    fromRole: ConnectionRole,
    data: string | ArrayBuffer
  ): void {
    const session = this.sessions.get(serverId);
    if (!session) return;

    const target = fromRole === "server" ? session.client : session.server;
    if (target) {
      try {
        target.send(data);
      } catch (error) {
        this.events.onError?.(
          serverId,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  /**
   * Get session info for debugging/monitoring.
   */
  getSession(serverId: string): RelaySession | undefined {
    return this.sessions.get(serverId);
  }

  /**
   * List all active sessions.
   */
  listSessions(): RelaySession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Close a session and both connections.
   */
  closeSession(serverId: string, code = 1000, reason = "Session closed"): void {
    const session = this.sessions.get(serverId);
    if (!session) return;

    session.server?.close(code, reason);
    session.client?.close(code, reason);

    this.sessions.delete(serverId);
    this.events.onSessionClosed?.(serverId);
  }

  /**
   * Restore sessions from persisted state (for Durable Objects hibernation).
   */
  restoreSessions(sessions: RelaySession[]): void {
    for (const session of sessions) {
      this.sessions.set(session.serverId, session);
    }
  }
}
