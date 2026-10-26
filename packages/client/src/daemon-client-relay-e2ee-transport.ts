import { MAX_RELAY_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/websocket-message-limit";
import {
  openClientSecureChannel,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  type SecureChannel,
  type SecurityMode,
  type Transport as RelayTransport,
} from "@getpaseo/relay/e2ee";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
} from "./daemon-client-transport-types.js";
import {
  extractRelayMessage,
  normalizeTransportPayload,
  messageTooLargeError,
} from "./daemon-client-transport-utils.js";

type OpenHandler = () => void;
type CloseHandler = (event?: unknown) => void;
type ErrorHandler = (event?: unknown) => void;
type MessageHandler = (data: unknown, isBinary: boolean) => void;

export interface RelayE2eeTransportOptions {
  daemonPublicKeyB64: string;
  logger: TransportLogger;
  assertOutboundCapacity?: (wireBytes: number) => void;
  /** Refuse to open unless the daemon negotiates at least this endpoint security mode. */
  minimumMode?: SecurityMode;
  /** Reports the negotiated mode once the daemon has authenticated the handshake. */
  onSecurityMode?: (mode: SecurityMode) => void;
}

export function createRelayE2eeTransportFactory(
  args: RelayE2eeTransportOptions & { baseFactory: DaemonTransportFactory },
): DaemonTransportFactory {
  const { baseFactory, ...options } = args;
  return ({ url }) => createEncryptedTransport(baseFactory({ url }), options);
}

const DAEMON_REQUIRES_PROTECTED_REASON = "daemon requires protected endpoint security";

/**
 * Returns a user-facing message when this client closed the session itself
 * because endpoint security could not be established, so reconnecting cannot help.
 *
 * The daemon's own policy close never reaches the client: both relays replace a
 * daemon-side close with their own code (1012 on the wrangler relay).
 */
export function describeEndpointSecurityClose(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const code = "code" in event ? event.code : undefined;
  const reason = "reason" in event && typeof event.reason === "string" ? event.reason : "";
  if (code === PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE) {
    return `Endpoint security handshake failed: ${reason || "protected mode unavailable"}`;
  }
  return null;
}

/**
 * The first session message from the daemon is `server_info`. A daemon that can
 * negotiate protected security advertises it there, so a legacy session with such
 * a daemon was downgraded in transit and must not proceed to admission.
 */
function readServerInfoProtectedSupport(text: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "session" || !isRecord(parsed.message)) return null;
  const message = parsed.message;
  if (message.type !== "status" || !isRecord(message.payload)) return null;
  if (message.payload.status !== "server_info") return null;
  const features = message.payload.features;
  return isRecord(features) && features.relayProtectedSecurity === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Relay upgrades carry routing only. Daemon credentials and subprotocols must
 * never reach the relay; they travel inside the encrypted hello.
 */
export function createRelayUpgradeTransportFactory(
  baseFactory: DaemonTransportFactory,
): DaemonTransportFactory {
  return ({ url }) => baseFactory({ url });
}

export function createEncryptedTransport(
  base: DaemonTransport,
  options: RelayE2eeTransportOptions,
): DaemonTransport {
  const { daemonPublicKeyB64, logger, minimumMode, onSecurityMode } = options;
  const assertOutboundCapacity = options.assertOutboundCapacity ?? (() => {});
  let channel: SecureChannel | null = null;
  let opened = false;
  let closed = false;
  let awaitingServerInfo = true;

  const openHandlers = new Set<OpenHandler>();
  const closeHandlers = new Set<CloseHandler>();
  const errorHandlers = new Set<ErrorHandler>();
  const messageHandlers = new Set<MessageHandler>();

  const emitOpen = () => {
    if (opened || closed) {
      return;
    }
    opened = true;
    emitHandlers(openHandlers);
  };

  const emitClose = (event?: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    emitHandlers(closeHandlers, event);
  };

  const emitError = (event?: unknown) => {
    if (closed) {
      return;
    }
    emitHandlers(errorHandlers, event);
  };

  const emitMessage = (data: unknown) => {
    if (closed) {
      return;
    }
    if (awaitingServerInfo && typeof data === "string") {
      const daemonSupportsProtected = readServerInfoProtectedSupport(data);
      if (daemonSupportsProtected !== null) {
        awaitingServerInfo = false;
        if (daemonSupportsProtected && channel?.securityMode() === "legacy") {
          logger.warn(
            { reason: DAEMON_REQUIRES_PROTECTED_REASON },
            "relay_e2ee_downgrade_rejected",
          );
          channel.close(PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, DAEMON_REQUIRES_PROTECTED_REASON);
          return;
        }
      }
    }
    emitHandlers(messageHandlers, data, data instanceof ArrayBuffer);
  };

  const relayTransport: RelayTransport = {
    send: (data) => {
      if (typeof data === "string") {
        base.send(data);
        return;
      }
      if (ArrayBuffer.isView(data)) {
        base.send(normalizeTransportPayload(data));
        return;
      }
      if (data instanceof ArrayBuffer) {
        base.send(data);
        return;
      }
      base.send(String(data));
    },
    // The channel decides the close code. Report it now: a socket close event
    // arrives asynchronously, and the consumer must not act on an earlier
    // error before it has seen the code.
    close: (code?: number, reason?: string) => {
      base.close(code, reason);
      emitClose({ code, reason });
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const startHandshake = async () => {
    try {
      channel = await openClientSecureChannel(relayTransport, {
        daemonPublicKeyB64,
        ...(minimumMode ? { minimumMode } : {}),
        events: {
          onopen: () => {
            onSecurityMode?.(channel?.securityMode() ?? "legacy");
            emitOpen();
          },
          onmessage: (data) => emitMessage(data),
          onclose: (code, reason) => emitClose({ code, reason }),
          // Every fatal channel error is followed by a close that carries the
          // code and reason; forwarding the error first would make the consumer
          // reconnect before it sees them.
          onerror: (error) => {
            logger.warn({ err: normalizeTransportError(error) }, "relay_e2ee_channel_error");
          },
        },
      });
    } catch (error) {
      logger.warn({ err: normalizeTransportError(error) }, "relay_e2ee_handshake_failed");
      emitError(error);
      // Browser WebSocket.close only accepts 1000 or 3000-4999.
      // Use an app-defined code so this path works in browser and Node runtimes.
      base.close(4001, "E2EE handshake failed");
    }
  };

  base.onOpen(() => {
    void startHandshake();
  });
  base.onMessage((data, isBinary) => {
    relayTransport.onmessage?.(extractRelayMessage(data, isBinary));
  });
  base.onClose((event) => {
    const record = event as { code?: number; reason?: string } | undefined;
    relayTransport.onclose?.(record?.code ?? 0, record?.reason ?? "");
    emitClose(event);
  });
  base.onError((event) => {
    relayTransport.onerror?.(event instanceof Error ? event : new Error(String(event)));
    emitError(event);
  });

  return {
    send: (data) => {
      if (!channel) {
        throw new Error("Encrypted channel not ready");
      }
      const payload = normalizeTransportPayload(data);
      // Reject synchronously so the requesting operation fails without closing the transport.
      const wireBytes = channel.outboundWireByteLength(payload);
      if (wireBytes > MAX_RELAY_WEBSOCKET_MESSAGE_BYTES) {
        throw messageTooLargeError(wireBytes, MAX_RELAY_WEBSOCKET_MESSAGE_BYTES);
      }
      // Encryption and its transport handoff are synchronous up to send's first await.
      // Reject capacity failures here so a routed sender loses only its own channel.
      assertOutboundCapacity(wireBytes);
      void channel.send(payload).catch((error) => {
        emitError(error);
      });
    },
    close: (code?: number, reason?: string) => {
      if (channel) {
        channel.close(code, reason);
      } else {
        base.close(code, reason);
      }
      emitClose({ code, reason });
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onOpen: (handler) => {
      openHandlers.add(handler);
      if (opened) {
        invokeHandler(handler);
      }
      return () => openHandlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      if (closed) {
        invokeHandler(handler);
      }
      return () => closeHandlers.delete(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
  };
}

function emitHandlers<TArgs extends unknown[]>(
  handlers: Set<(...args: TArgs) => void>,
  ...args: TArgs
) {
  for (const handler of handlers) {
    invokeHandler(handler, ...args);
  }
}

function invokeHandler<TArgs extends unknown[]>(handler: (...args: TArgs) => void, ...args: TArgs) {
  try {
    handler(...args);
  } catch {
    // no-op
  }
}

function normalizeTransportError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
