import type {
  DaemonTransportFactory,
  WebSocketFactory,
  WebSocketLike,
} from "./daemon-client-transport-types.js";

export function defaultWebSocketFactory(
  url: string,
  options?: { headers?: Record<string, string>; protocols?: string[] },
): WebSocketLike {
  const globalWs = (
    globalThis as {
      WebSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike;
    }
  ).WebSocket;
  if (!globalWs) {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new globalWs(url, options?.protocols);
}

export function createWebSocketTransportFactory(factory: WebSocketFactory): DaemonTransportFactory {
  return ({ url, headers, protocols }) => {
    const ws = factory(url, { headers, protocols });
    if ("binaryType" in ws) {
      try {
        ws.binaryType = "arraybuffer";
      } catch {
        // no-op
      }
    }
    return {
      send: (data) => {
        if (typeof ws.readyState === "number" && ws.readyState !== 1) {
          throw new Error(`WebSocket not open (readyState=${ws.readyState})`);
        }
        ws.send(data);
      },
      close: (code?: number, reason?: string) => {
        // Node's `ws` may emit an `error` when a connecting socket is closed before the
        // handshake completes. Keep a temporary no-op handler attached so cleanup during
        // connect timeouts does not crash the CLI with an unhandled error event.
        const suppressEarlyCloseError = bindTemporaryEarlyCloseErrorHandler(ws);
        try {
          ws.close(code, reason);
        } finally {
          if (typeof ws.on !== "function" && typeof ws.addEventListener !== "function") {
            suppressEarlyCloseError();
          }
        }
      },
      onOpen: (handler) => bindWsHandler(ws, "open", handler),
      onClose: (handler) => bindWsHandler(ws, "close", handler),
      onError: (handler) => bindWsHandler(ws, "error", handler),
      onMessage: (handler) => bindWsHandler(ws, "message", handler),
    };
  };
}

function bindTemporaryEarlyCloseErrorHandler(ws: WebSocketLike): () => void {
  const noop = () => {};

  if (typeof ws.addEventListener === "function") {
    ws.addEventListener("error", noop);
    const removeOnClose = bindWsHandler(ws, "close", () => {
      removeOnClose();
      if (typeof ws.removeEventListener === "function") {
        ws.removeEventListener("error", noop);
      }
    });
    return () => {
      removeOnClose();
      if (typeof ws.removeEventListener === "function") {
        ws.removeEventListener("error", noop);
      }
    };
  }

  if (typeof ws.on === "function") {
    ws.on("error", noop);
    const removeOnClose = bindWsHandler(ws, "close", () => {
      removeOnClose();
      if (typeof ws.off === "function") {
        ws.off("error", noop);
        return;
      }
      if (typeof ws.removeListener === "function") {
        ws.removeListener("error", noop);
      }
    });
    return () => {
      removeOnClose();
      if (typeof ws.off === "function") {
        ws.off("error", noop);
        return;
      }
      if (typeof ws.removeListener === "function") {
        ws.removeListener("error", noop);
      }
    };
  }

  return () => {};
}

export function bindWsHandler(
  ws: WebSocketLike,
  event: "open" | "close" | "error" | "message",
  handler: (...args: unknown[]) => void,
): () => void {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(event, handler);
    return () => {
      if (typeof ws.removeEventListener === "function") {
        ws.removeEventListener(event, handler);
      }
    };
  }
  if (typeof ws.on === "function") {
    ws.on(event, handler);
    return () => {
      if (typeof ws.off === "function") {
        ws.off(event, handler);
        return;
      }
      if (typeof ws.removeListener === "function") {
        ws.removeListener(event, handler);
      }
    };
  }
  const prop = `on${event}`;
  const wsRecord = ws as unknown as Record<string, unknown>;
  const previous = wsRecord[prop];
  wsRecord[prop] = handler;
  return () => {
    if (wsRecord[prop] === handler) {
      wsRecord[prop] = previous ?? null;
    }
  };
}
