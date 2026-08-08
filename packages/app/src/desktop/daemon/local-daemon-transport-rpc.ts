import {
  closeLocalTransportSession,
  listenToLocalTransportEvents,
  openLocalTransportSession,
  openWebSocketTransportSession,
  sendLocalTransportMessage,
  type DesktopDaemonTransportTarget,
  type WebSocketTransportTarget,
} from "./desktop-daemon";

export interface LocalDaemonTransportEvent {
  sessionId: string;
  kind: "open" | "message" | "close" | "error";
  text?: string | null;
  binaryBase64?: string | null;
  code?: number | null;
  reason?: string | null;
  error?: string | null;
}

export interface LocalDaemonTransportRpc {
  openSession(target: DesktopDaemonTransportTarget): Promise<string>;
  listenToEvents(handler: (event: LocalDaemonTransportEvent) => void): Promise<() => void>;
  sendMessage(input: { sessionId: string; text?: string; binaryBase64?: string }): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

export const defaultLocalDaemonTransportRpc: LocalDaemonTransportRpc = {
  openSession: openLocalTransportSession,
  listenToEvents: listenToLocalTransportEvents,
  sendMessage: sendLocalTransportMessage,
  closeSession: closeLocalTransportSession,
};

export const defaultWebSocketDaemonTransportRpc: LocalDaemonTransportRpc = {
  openSession: (target) => openWebSocketTransportSession(target as WebSocketTransportTarget),
  listenToEvents: listenToLocalTransportEvents,
  sendMessage: sendLocalTransportMessage,
  closeSession: closeLocalTransportSession,
};
