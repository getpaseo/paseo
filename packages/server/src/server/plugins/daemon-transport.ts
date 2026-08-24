import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

interface PluginProcessPort {
  send(message: PluginProcessMessage): void;
  onMessage(handler: (message: PluginProcessRequest) => void): () => void;
}

function normalizeFrame(data: string | Uint8Array | ArrayBuffer): string | Uint8Array {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

export function createPluginDaemonTransportFactory(
  port: PluginProcessPort,
): DaemonTransportFactory {
  return () => {
    const messageHandlers = new Set<(data: unknown, isBinary: boolean) => void>();
    const openHandlers = new Set<() => void>();
    const closeHandlers = new Set<(event?: unknown) => void>();
    let isOpen = true;
    const unsubscribe = port.onMessage((message) => {
      if (message.type === "paseo_frame") {
        for (const handler of messageHandlers) handler(message.data, message.isBinary);
      }
      if (message.type === "paseo_close") closeTransport();
    });

    function closeTransport(): void {
      if (!isOpen) return;
      isOpen = false;
      unsubscribe();
      for (const handler of closeHandlers) handler();
    }

    queueMicrotask(() => {
      if (!isOpen) return;
      for (const handler of openHandlers) handler();
    });

    return {
      send(data) {
        if (!isOpen) throw new Error("Plugin daemon transport is closed");
        const frame = normalizeFrame(data);
        port.send({ type: "paseo_frame", data: frame, isBinary: typeof frame !== "string" });
      },
      close() {
        if (!isOpen) return;
        port.send({ type: "paseo_close" });
        closeTransport();
      },
      onMessage(handler) {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      onOpen(handler) {
        openHandlers.add(handler);
        return () => openHandlers.delete(handler);
      },
      onClose(handler) {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
      onError() {
        return () => undefined;
      },
    };
  };
}
