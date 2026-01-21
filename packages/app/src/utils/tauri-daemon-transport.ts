import type { DaemonTransport, DaemonTransportFactory } from "@server/client/daemon-client-v2";

type TauriWebSocketMessage =
  | { type: "Text"; data: string }
  | { type: "Binary"; data: number[] }
  | { type: "Ping"; data: number[] }
  | { type: "Pong"; data: number[] }
  | { type: "Close"; data: { code: number; reason: string } | null };

type TauriWebSocketConnection = {
  addListener(cb: (msg: TauriWebSocketMessage) => void): () => void;
  send(message: string | number[] | TauriWebSocketMessage): Promise<void>;
  disconnect(): Promise<void>;
};

type TauriWebSocketModule = {
  connect(url: string, config?: unknown): Promise<TauriWebSocketConnection>;
};

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && (window as any).__TAURI__ !== undefined;
}

function getTauriWebSocketModule(): TauriWebSocketModule | null {
  if (!isTauriEnvironment()) {
    return null;
  }
  const ws = (window as any).__TAURI__?.websocket;
  if (ws && typeof ws.connect === "function") {
    return ws as TauriWebSocketModule;
  }
  return null;
}

export function createTauriWebSocketTransportFactory(): DaemonTransportFactory | null {
  if (!isTauriEnvironment()) {
    return null;
  }

  return ({ url }) => {
    let ws: TauriWebSocketConnection | null = null;
    let wsListenerCleanup: (() => void) | null = null;
    let disposed = false;
    let opened = false;
    let closeEmitted = false;

    const openHandlers = new Set<() => void>();
    const closeHandlers = new Set<(event?: unknown) => void>();
    const errorHandlers = new Set<(event?: unknown) => void>();
    const messageHandlers = new Set<(data: unknown) => void>();

    const pendingSends: string[] = [];
    let closeRequested: { code?: number; reason?: string } | null = null;

    const emitOpen = () => {
      if (disposed || opened) return;
      opened = true;
      for (const handler of openHandlers) {
        try {
          handler();
        } catch {
          // no-op
        }
      }
    };

    const emitClose = (event?: unknown) => {
      if (disposed || closeEmitted) return;
      closeEmitted = true;
      for (const handler of closeHandlers) {
        try {
          handler(event);
        } catch {
          // no-op
        }
      }
    };

    const emitError = (event?: unknown) => {
      if (disposed) return;
      for (const handler of errorHandlers) {
        try {
          handler(event);
        } catch {
          // no-op
        }
      }
    };

    const emitMessage = (data: unknown) => {
      if (disposed) return;
      for (const handler of messageHandlers) {
        try {
          handler(data);
        } catch {
          // no-op
        }
      }
    };

    const connect = async () => {
      try {
        let module: TauriWebSocketModule | null = getTauriWebSocketModule();
        if (!module) {
          const start = Date.now();
          while (!module && Date.now() - start < 2000) {
            await new Promise((r) => setTimeout(r, 50));
            module = getTauriWebSocketModule();
          }
        }
        if (!module) {
          throw new Error(
            "Tauri WebSocket plugin is not available (expected window.__TAURI__.websocket). Did you enable tauri-plugin-websocket and websocket:default capability?"
          );
        }

        const socket = await module.connect(url);
        if (disposed) {
          try {
            await socket.disconnect();
          } catch {
            // no-op
          }
          return;
        }

        ws = socket;

        wsListenerCleanup = ws.addListener((msg) => {
          if (msg.type === "Text") {
            emitMessage({ data: msg.data });
            return;
          }
          if (msg.type === "Close") {
            emitClose(msg.data ?? undefined);
            return;
          }
        });

        emitOpen();

        while (pendingSends.length > 0) {
          const next = pendingSends.shift();
          if (!next) break;
          try {
            await ws.send(next);
          } catch (error) {
            emitError(error);
          }
        }

        if (closeRequested) {
          try {
            await ws.disconnect();
          } catch (error) {
            emitError(error);
          } finally {
            emitClose(closeRequested);
          }
        }
      } catch (error) {
        emitError(error);
      }
    };

    void connect();

    const transport: DaemonTransport = {
      send: (data) => {
        if (disposed) return;
        if (!ws) {
          pendingSends.push(data);
          return;
        }
        void ws.send(data).catch((error) => emitError(error));
      },
      close: (code?: number, reason?: string) => {
        if (disposed) return;
        closeRequested = { code, reason };
        if (!ws) return;
        void ws
          .disconnect()
          .catch((error) => emitError(error))
          .finally(() => emitClose(closeRequested));
      },
      onMessage: (handler) => {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      onOpen: (handler) => {
        openHandlers.add(handler);
        if (opened) {
          try {
            handler();
          } catch {
            // no-op
          }
        }
        return () => openHandlers.delete(handler);
      },
      onClose: (handler) => {
        closeHandlers.add(handler);
        if (closeEmitted) {
          try {
            handler(closeRequested ?? undefined);
          } catch {
            // no-op
          }
        }
        return () => closeHandlers.delete(handler);
      },
      onError: (handler) => {
        errorHandlers.add(handler);
        return () => errorHandlers.delete(handler);
      },
    };

    return {
      ...transport,
      close: (code?: number, reason?: string) => {
        transport.close(code, reason);
        disposed = true;
        try {
          wsListenerCleanup?.();
        } catch {
          // no-op
        }
        wsListenerCleanup = null;
      },
    };
  };
}
