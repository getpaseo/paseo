import type { DaemonTransport, DaemonTransportFactory } from "@server/client/daemon-client";
import {
  closeLocalTransportSession,
  listenToLocalTransportEvents,
  openLocalTransportSession,
  sendLocalTransportMessage,
  type LocalTransportTarget,
} from "./desktop-daemon";

const LOCAL_TRANSPORT_SCHEME = "paseo+local:";

function encodeBinaryToBase64(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return globalThis.btoa(binary);
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function buildLocalDaemonTransportUrl(target: LocalTransportTarget): string {
  const url = new URL(`${LOCAL_TRANSPORT_SCHEME}//${target.transportType}`);
  url.searchParams.set("path", target.transportPath);
  return url.toString();
}

function parseLocalDaemonTransportUrl(url: string): LocalTransportTarget {
  const parsed = new URL(url);
  if (parsed.protocol !== LOCAL_TRANSPORT_SCHEME) {
    throw new Error(`Unsupported local transport URL: ${url}`);
  }
  const transportType = parsed.hostname;
  const transportPath = parsed.searchParams.get("path")?.trim() ?? "";
  if ((transportType !== "socket" && transportType !== "pipe") || !transportPath) {
    throw new Error(`Invalid local transport target: ${url}`);
  }
  return {
    transportType,
    transportPath,
  };
}

export function createDesktopLocalDaemonTransportFactory(): DaemonTransportFactory | null {
  return ({ url }) => {
    const target = parseLocalDaemonTransportUrl(url);
    let sessionId: string | null = null;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    let didEmitOpen = false;

    const openHandlers = new Set<() => void>();
    const closeHandlers = new Set<(event?: unknown) => void>();
    const errorHandlers = new Set<(event?: unknown) => void>();
    const messageHandlers = new Set<(data: unknown) => void>();

    const emitOpen = () => {
      if (didEmitOpen || disposed) {
        return;
      }
      didEmitOpen = true;
      for (const handler of openHandlers) {
        handler();
      }
    };
    const emitClose = (event?: unknown) => {
      for (const handler of closeHandlers) {
        handler(event);
      }
    };
    const emitError = (event?: unknown) => {
      for (const handler of errorHandlers) {
        handler(event);
      }
    };
    const emitMessage = (data: unknown) => {
      for (const handler of messageHandlers) {
        handler(data);
      }
    };

    void listenToLocalTransportEvents((payload) => {
      if (disposed || !sessionId || payload.sessionId !== sessionId) {
        return;
      }
      if (payload.kind === "open") {
        emitOpen();
        return;
      }
      if (payload.kind === "message") {
        if (payload.text) {
          emitMessage({ data: payload.text });
          return;
        }
        if (payload.binaryBase64) {
          emitMessage({ data: decodeBase64ToBytes(payload.binaryBase64) });
        }
        return;
      }
      if (payload.kind === "close") {
        emitClose(payload);
        return;
      }
      emitError(payload.error ?? "Local daemon transport error");
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        return;
      })
      .catch((error) => {
        emitError(error);
      });

    void openLocalTransportSession(target)
      .then((id) => {
        if (disposed) {
          void closeLocalTransportSession(id).catch((error) => emitError(error));
          return;
        }
        sessionId = id;
        emitOpen();
        return;
      })
      .catch((error) => {
        emitError(error);
      });

    const transport: DaemonTransport = {
      send: (data) => {
        if (!sessionId) {
          return;
        }
        if (typeof data === "string") {
          void sendLocalTransportMessage({ sessionId, text: data }).catch((error) =>
            emitError(error),
          );
          return;
        }
        const binaryBase64 = encodeBinaryToBase64(
          data instanceof ArrayBuffer ? data : new Uint8Array(data),
        );
        void sendLocalTransportMessage({ sessionId, binaryBase64 }).catch((error) =>
          emitError(error),
        );
      },
      close: () => {
        disposed = true;
        const currentSessionId = sessionId;
        sessionId = null;
        if (currentSessionId) {
          void closeLocalTransportSession(currentSessionId).catch((error) => emitError(error));
        }
        unlisten?.();
        unlisten = null;
      },
      onMessage: (handler) => {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      onOpen: (handler) => {
        openHandlers.add(handler);
        return () => openHandlers.delete(handler);
      },
      onClose: (handler) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
      onError: (handler) => {
        errorHandlers.add(handler);
        return () => errorHandlers.delete(handler);
      },
    };

    return transport;
  };
}
