import {
  createClientChannel,
  type EncryptedChannel,
  type Transport as RelayTransport,
} from "@getpaseo/relay/e2ee";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
} from "./daemon-client-transport-types.js";
import {
  extractRelayMessageData,
  normalizeTransportPayload,
} from "./daemon-client-transport-utils.js";

type OpenHandler = () => void;
type CloseHandler = (event?: unknown) => void;
type ErrorHandler = (event?: unknown) => void;
type MessageHandler = (data: unknown) => void;

export function createRelayE2eeTransportFactory(args: {
  baseFactory: DaemonTransportFactory;
  daemonPublicKeyB64: string;
  logger: TransportLogger;
}): DaemonTransportFactory {
  return ({ url, headers }) => {
    const base = args.baseFactory({ url, headers });
    return createEncryptedTransport(base, args.daemonPublicKeyB64, args.logger);
  };
}

export function createEncryptedTransport(
  base: DaemonTransport,
  daemonPublicKeyB64: string,
  logger: TransportLogger
): DaemonTransport {
  let channel: EncryptedChannel | null = null;
  let opened = false;
  let closed = false;

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
    emitHandlers(messageHandlers, data);
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
    close: (code?: number, reason?: string) => base.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const startHandshake = async () => {
    try {
      channel = await createClientChannel(relayTransport, daemonPublicKeyB64, {
        onopen: emitOpen,
        onmessage: (data) => emitMessage(data),
        onclose: (code, reason) => emitClose({ code, reason }),
        onerror: (error) => emitError(error),
      });
    } catch (error) {
      logger.warn({ err: error }, "relay_e2ee_handshake_failed");
      emitError(error);
      base.close(1011, "E2EE handshake failed");
    }
  };

  base.onOpen(() => {
    void startHandshake();
  });
  base.onMessage((event) => {
    relayTransport.onmessage?.(extractRelayMessageData(event));
  });
  base.onClose((event) => {
    const record = event as { code?: number; reason?: string } | undefined;
    relayTransport.onclose?.(record?.code ?? 0, record?.reason ?? "");
    emitClose(event);
  });
  base.onError((event) => {
    relayTransport.onerror?.(
      event instanceof Error ? event : new Error(String(event))
    );
    emitError(event);
  });

  return {
    send: (data) => {
      if (!channel) {
        throw new Error("Encrypted channel not ready");
      }
      void channel.send(normalizeTransportPayload(data)).catch((error) => {
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

function invokeHandler<TArgs extends unknown[]>(
  handler: (...args: TArgs) => void,
  ...args: TArgs
) {
  try {
    handler(...args);
  } catch {
    // no-op
  }
}
