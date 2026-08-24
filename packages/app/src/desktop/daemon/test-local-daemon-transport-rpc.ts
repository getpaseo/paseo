import type { LocalTransportTarget } from "./desktop-daemon";
import type {
  LocalDaemonTransportEvent,
  LocalDaemonTransportRpc,
} from "./local-daemon-transport-rpc";

export interface RecordedSend {
  sessionId: string;
  text?: string;
  binaryBase64?: string;
}

export interface FakeLocalDaemonTransportRpc extends LocalDaemonTransportRpc {
  readonly openCalls: LocalTransportTarget[];
  readonly recordedSends: RecordedSend[];
  readonly closedSessions: string[];
  resolveOpen(sessionId: string): void;
  rejectOpen(error: Error): void;
  resolveListen(cleanup: () => void): void;
  rejectListen(error: Error): void;
  emitEvent(event: LocalDaemonTransportEvent): void;
}

export function createFakeLocalDaemonTransportRpc(): FakeLocalDaemonTransportRpc {
  const openCalls: LocalTransportTarget[] = [];
  const recordedSends: RecordedSend[] = [];
  const closedSessions: string[] = [];
  let eventHandler: ((event: LocalDaemonTransportEvent) => void) | null = null;
  let resolveOpenSession: ((sessionId: string) => void) | null = null;
  let rejectOpenSession: ((error: Error) => void) | null = null;
  let resolveListenPromise: ((cleanup: () => void) => void) | null = null;
  let rejectListenPromise: ((error: Error) => void) | null = null;

  return {
    openCalls,
    recordedSends,
    closedSessions,
    openSession(target) {
      openCalls.push(target);
      return new Promise<string>((resolve, reject) => {
        resolveOpenSession = resolve;
        rejectOpenSession = reject;
      });
    },
    listenToEvents(handler) {
      eventHandler = handler;
      return new Promise<() => void>((resolve, reject) => {
        resolveListenPromise = resolve;
        rejectListenPromise = reject;
      });
    },
    async sendMessage(input) {
      recordedSends.push(input);
    },
    async closeSession(sessionId) {
      closedSessions.push(sessionId);
    },
    resolveOpen(sessionId) {
      if (!resolveOpenSession) {
        throw new Error("openSession was not called");
      }
      resolveOpenSession(sessionId);
    },
    rejectOpen(error) {
      if (!rejectOpenSession) {
        throw new Error("openSession was not called");
      }
      rejectOpenSession(error);
    },
    resolveListen(cleanup) {
      if (!resolveListenPromise) {
        throw new Error("listenToEvents was not called");
      }
      resolveListenPromise(cleanup);
    },
    rejectListen(error) {
      if (!rejectListenPromise) {
        throw new Error("listenToEvents was not called");
      }
      rejectListenPromise(error);
    },
    emitEvent(event) {
      eventHandler?.(event);
    },
  };
}
