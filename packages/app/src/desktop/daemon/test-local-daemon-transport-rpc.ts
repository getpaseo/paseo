import type { OpenLocalTransportSessionInput } from "./desktop-daemon";
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
  readonly openCalls: OpenLocalTransportSessionInput[];
  readonly recordedSends: RecordedSend[];
  readonly closedSessions: string[];
  resolveRegistration(): void;
  rejectOpen(error: Error): void;
  resolveListen(cleanup: () => void): void;
  rejectListen(error: Error): void;
  emitEvent(event: LocalDaemonTransportEvent): void;
}

export function createFakeLocalDaemonTransportRpc(): FakeLocalDaemonTransportRpc {
  const openCalls: OpenLocalTransportSessionInput[] = [];
  const recordedSends: RecordedSend[] = [];
  const closedSessions: string[] = [];
  let eventHandler: ((event: LocalDaemonTransportEvent) => void) | null = null;
  let resolveRegistrationPromise: (() => void) | null = null;
  let rejectRegistrationPromise: ((error: Error) => void) | null = null;
  let resolveListenPromise: ((cleanup: () => void) => void) | null = null;
  let rejectListenPromise: ((error: Error) => void) | null = null;

  return {
    openCalls,
    recordedSends,
    closedSessions,
    openSession(input) {
      openCalls.push(input);
      return new Promise<void>((resolve, reject) => {
        resolveRegistrationPromise = resolve;
        rejectRegistrationPromise = reject;
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
    resolveRegistration() {
      if (!resolveRegistrationPromise) {
        throw new Error("openSession was not called");
      }
      resolveRegistrationPromise();
    },
    rejectOpen(error) {
      if (!rejectRegistrationPromise) {
        throw new Error("openSession was not called");
      }
      rejectRegistrationPromise(error);
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
