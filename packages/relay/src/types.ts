/**
 * Relay connection types and interfaces.
 *
 * The relay bridges two WebSocket connections:
 * - Server (daemon): The Paseo server connecting to the relay
 * - Client (app): The mobile/web app connecting to the relay
 *
 * Messages are forwarded bidirectionally without modification.
 */

export type ConnectionRole = "server" | "client";

export interface RelaySession {
  id: string;
  server: RelayConnection | null;
  client: RelayConnection | null;
  createdAt: number;
}

export interface RelayConnection {
  role: ConnectionRole;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface RelaySessionAttachment {
  sessionId: string;
  role: ConnectionRole;
  createdAt: number;
}

export interface RelayEvents {
  onSessionCreated?(sessionId: string): void;
  onSessionBridged?(sessionId: string): void;
  onSessionClosed?(sessionId: string): void;
  onError?(sessionId: string, error: Error): void;
}
