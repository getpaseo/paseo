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
    sessionId: string,
    role: ConnectionRole,
    connection: RelayConnection
  ): void {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        server: null,
        client: null,
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
      this.events.onSessionCreated?.(sessionId);
    }

    const existingConnection = session[role];
    if (existingConnection) {
      existingConnection.close(1008, "Replaced by new connection");
    }

    session[role] = connection;

    if (session.server && session.client) {
      this.events.onSessionBridged?.(sessionId);
    }
  }

  /**
   * Remove a connection from a session.
   * If both connections are gone, the session is cleaned up.
   */
  removeConnection(sessionId: string, role: ConnectionRole): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session[role] = null;

    if (!session.server && !session.client) {
      this.sessions.delete(sessionId);
      this.events.onSessionClosed?.(sessionId);
    }
  }

  /**
   * Forward a message from one side to the other.
   */
  forward(
    sessionId: string,
    fromRole: ConnectionRole,
    data: string | ArrayBuffer
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const target = fromRole === "server" ? session.client : session.server;
    if (target) {
      try {
        target.send(data);
      } catch (error) {
        this.events.onError?.(
          sessionId,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  /**
   * Get session info for debugging/monitoring.
   */
  getSession(sessionId: string): RelaySession | undefined {
    return this.sessions.get(sessionId);
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
  closeSession(sessionId: string, code = 1000, reason = "Session closed"): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.server?.close(code, reason);
    session.client?.close(code, reason);

    this.sessions.delete(sessionId);
    this.events.onSessionClosed?.(sessionId);
  }

  /**
   * Restore sessions from persisted state (for Durable Objects hibernation).
   */
  restoreSessions(sessions: RelaySession[]): void {
    for (const session of sessions) {
      this.sessions.set(session.id, session);
    }
  }
}
