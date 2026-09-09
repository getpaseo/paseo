import {
  closeLocalTransportSession,
  listenToLocalTransportEvents,
  openLocalTransportSession,
  sendLocalTransportMessage,
  type OpenLocalTransportSessionInput,
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
  openSession(input: OpenLocalTransportSessionInput): Promise<void>;
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
