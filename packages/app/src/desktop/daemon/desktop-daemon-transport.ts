import type {
  DaemonTransport,
  DaemonTransportFactory,
} from "@getpaseo/client/internal/daemon-client";
import { validatePort, validateSshHost } from "@getpaseo/protocol/ssh-transport";
import type { DesktopDaemonTransportTarget } from "./desktop-daemon";
import {
  defaultLocalDaemonTransportRpc,
  type LocalDaemonTransportEvent,
  type LocalDaemonTransportRpc,
} from "./local-daemon-transport-rpc";

const DESKTOP_TRANSPORT_SCHEME = "paseo+desktop:";

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

export function buildDesktopDaemonTransportUrl(target: DesktopDaemonTransportTarget): string {
  const url = new URL(`${DESKTOP_TRANSPORT_SCHEME}//${target.transportType}`);
  if (target.transportType === "ssh") {
    url.searchParams.set("host", target.host);
    if (target.sshPort !== undefined) {
      url.searchParams.set("port", String(target.sshPort));
    }
    if (target.daemonPort !== undefined) {
      url.searchParams.set("daemonPort", String(target.daemonPort));
    }
  } else {
    url.searchParams.set("path", target.transportPath);
  }
  return url.toString();
}

function parseDesktopDaemonTransportUrl(url: string): DesktopDaemonTransportTarget {
  const parsed = new URL(url);
  if (parsed.protocol !== DESKTOP_TRANSPORT_SCHEME) {
    throw new Error(`Unsupported desktop transport URL: ${url}`);
  }
  const transportType = parsed.hostname;
  if (transportType === "ssh") return parseSshDesktopTransportUrl(parsed, url);
  const transportPath = parsed.searchParams.get("path")?.trim() ?? "";
  if ((transportType !== "socket" && transportType !== "pipe") || !transportPath) {
    throw new Error(`Invalid desktop transport target: ${url}`);
  }
  return {
    transportType,
    transportPath,
  };
}

function parseSshDesktopTransportUrl(parsed: URL, rawUrl: string): DesktopDaemonTransportTarget {
  try {
    const host = validateSshHost(parsed.searchParams.get("host") ?? "");
    const sshPort = parseOptionalUrlPort(parsed, "port", "SSH port");
    const daemonPort = parseOptionalUrlPort(parsed, "daemonPort", "Daemon port");
    return {
      transportType: "ssh",
      host,
      ...(sshPort !== undefined ? { sshPort } : {}),
      ...(daemonPort !== undefined ? { daemonPort } : {}),
    };
  } catch (error) {
    throw new Error(`Invalid SSH transport target: ${rawUrl}`, { cause: error });
  }
}

function parseOptionalUrlPort(parsed: URL, key: string, label: string): number | undefined {
  const value = parsed.searchParams.get(key);
  return value === null ? undefined : validatePort(value, label);
}

export function createDesktopDaemonTransportFactory(
  rpc: LocalDaemonTransportRpc = defaultLocalDaemonTransportRpc,
): DaemonTransportFactory | null {
  return ({ url }) => {
    const target = parseDesktopDaemonTransportUrl(url);
    const sessionId = `local-session-${globalThis.crypto.randomUUID()}`;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    let didEmitOpen = false;

    const openHandlers = new Set<() => void>();
    const closeHandlers = new Set<(event?: unknown) => void>();
    const errorHandlers = new Set<(event?: unknown) => void>();
    const messageHandlers = new Set<(data: unknown, isBinary: boolean) => void>();

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
      if (disposed) {
        return;
      }
      for (const handler of errorHandlers) {
        handler(event);
      }
    };
    const emitMessage = (data: unknown, isBinary: boolean) => {
      for (const handler of messageHandlers) {
        handler(data, isBinary);
      }
    };

    const handleEvent = (payload: LocalDaemonTransportEvent) => {
      if (disposed || payload.sessionId !== sessionId) {
        return;
      }
      if (payload.kind === "open") {
        emitOpen();
        return;
      }
      if (payload.kind === "message") {
        if (payload.text) {
          emitMessage(payload.text, false);
          return;
        }
        if (payload.binaryBase64) {
          emitMessage(decodeBase64ToBytes(payload.binaryBase64), true);
        }
        return;
      }
      if (payload.kind === "close") {
        emitClose(payload);
        return;
      }
      emitError(payload.error ?? "Local daemon transport error");
    };

    void (async () => {
      try {
        const cleanup = await rpc.listenToEvents(handleEvent);
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;

        await rpc.openSession({ sessionId, target });
      } catch (error) {
        emitError(error);
      }
    })();

    const transport: DaemonTransport = {
      send: (data) => {
        if (!didEmitOpen) {
          return;
        }
        if (typeof data === "string") {
          void rpc.sendMessage({ sessionId, text: data }).catch((error) => emitError(error));
          return;
        }
        const binaryBase64 = encodeBinaryToBase64(
          data instanceof ArrayBuffer ? data : new Uint8Array(data),
        );
        void rpc.sendMessage({ sessionId, binaryBase64 }).catch((error) => emitError(error));
      },
      close: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        void rpc.closeSession(sessionId).catch((error) => emitError(error));
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
