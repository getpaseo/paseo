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
  serverId: string;
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
  serverId: string;
  role: ConnectionRole;
  createdAt: number;
}

export interface RelayEvents {
  onSessionCreated?(serverId: string): void;
  onSessionBridged?(serverId: string): void;
  onSessionClosed?(serverId: string): void;
  onError?(serverId: string, error: Error): void;
}
