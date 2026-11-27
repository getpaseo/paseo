import {
  WSTunnelHandshakeResponseSchema,
  type WSTunnelHandshakeResponse,
} from "@getpaseo/protocol/messages";
import { WebSocket, type RawData } from "ws";
export interface TunnelReadyLimits {
  maxFramePayloadBytes: number;
  initialStreamWindowBytes: number;
  initialConnectionWindowBytes: number;
}

export interface TunnelWireConnection {
  readonly ready: TunnelReadyLimits;
  sendBinary(bytes: Uint8Array): Promise<void>;
  onBinary(handler: (bytes: Uint8Array) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
  close(): void;
}

export class TunnelHandshakeError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "TunnelHandshakeError";
    this.code = code;
  }
}

export function rawDataToUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
  }
  return new Uint8Array(data);
}

export function waitForWebSocketOpen(
  ws: WebSocket,
  timeoutMs: number,
  getFailureDetail?: () => string | null,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(new Error("Timed out connecting tunnel WebSocket"));
    }, timeoutMs);
    timer.unref?.();

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      const detail = getFailureDetail?.();
      reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      const detail = getFailureDetail?.();
      let suffix = "";
      if (detail) {
        suffix = `: ${detail}`;
      } else if (reason.length > 0) {
        suffix = `: ${reason.toString("utf8")}`;
      }
      reject(new Error(`Tunnel WebSocket closed before open (${code})${suffix}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

export async function openPlainWebSocketTunnel(input: {
  url: string;
  ticket: string;
  timeoutMs: number;
  cleanupTarget?: () => void;
  getFailureDetail?: () => string | null;
}): Promise<TunnelWireConnection> {
  const ws = new WebSocket(input.url, { perMessageDeflate: false });
  try {
    await waitForWebSocketOpen(ws, input.timeoutMs, input.getFailureDetail);
  } catch (error) {
    input.cleanupTarget?.();
    throw error;
  }

  const binaryListeners = new Set<(bytes: Uint8Array) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let closed = false;
  let handshakeDone = false;

  const notifyClose = (error?: Error) => {
    if (closed) return;
    closed = true;
    input.cleanupTarget?.();
    for (const listener of closeListeners) {
      listener(error);
    }
    closeListeners.clear();
    binaryListeners.clear();
  };

  let resolveHandshake!: (response: WSTunnelHandshakeResponse) => void;
  let rejectHandshake!: (error: Error) => void;
  const handshakePromise = new Promise<WSTunnelHandshakeResponse>((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });

  const handshakeTimer = setTimeout(() => {
    if (!handshakeDone) {
      handshakeDone = true;
      rejectHandshake(new Error("Timed out waiting for tunnel_ready handshake"));
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      notifyClose(new Error("Tunnel handshake timeout"));
    }
  }, input.timeoutMs);
  handshakeTimer.unref?.();

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!handshakeDone) {
      if (isBinary) {
        handshakeDone = true;
        clearTimeout(handshakeTimer);
        rejectHandshake(new Error("Received binary frame before tunnel_ready handshake"));
        ws.close();
        return;
      }
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      try {
        const parsed = WSTunnelHandshakeResponseSchema.parse(JSON.parse(text));
        handshakeDone = true;
        clearTimeout(handshakeTimer);
        resolveHandshake(parsed);
      } catch (error) {
        handshakeDone = true;
        clearTimeout(handshakeTimer);
        rejectHandshake(
          error instanceof Error ? error : new Error("Invalid tunnel handshake response"),
        );
        ws.close();
      }
      return;
    }

    if (!isBinary) {
      // Ignore unexpected text after entering binary mode.
      return;
    }
    const bytes = rawDataToUint8Array(data);
    for (const listener of binaryListeners) {
      listener(bytes);
    }
  });

  ws.on("error", (error) => {
    if (!handshakeDone) {
      handshakeDone = true;
      clearTimeout(handshakeTimer);
      rejectHandshake(error);
    }
    notifyClose(error);
  });

  ws.on("close", (code, reason) => {
    const detail = reason.length > 0 ? reason.toString("utf8") : `code ${code}`;
    const err = new Error(`Tunnel closed (${detail})`);
    if (!handshakeDone) {
      handshakeDone = true;
      clearTimeout(handshakeTimer);
      rejectHandshake(err);
    }
    notifyClose(err);
  });

  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify({ type: "tunnel_hello", ticket: input.ticket }), (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  const handshake = await handshakePromise;
  if (handshake.type === "tunnel_error") {
    ws.close();
    notifyClose(new TunnelHandshakeError(handshake.code, handshake.message));
    throw new TunnelHandshakeError(handshake.code, handshake.message);
  }

  return {
    ready: {
      maxFramePayloadBytes: handshake.maxFramePayloadBytes,
      initialStreamWindowBytes: handshake.initialStreamWindowBytes,
      initialConnectionWindowBytes: handshake.initialConnectionWindowBytes,
    },
    sendBinary: (bytes) =>
      new Promise<void>((resolve, reject) => {
        if (closed || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Tunnel WebSocket is not open"));
          return;
        }
        ws.send(bytes, { binary: true }, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    onBinary: (handler) => {
      binaryListeners.add(handler);
      return () => {
        binaryListeners.delete(handler);
      };
    },
    onClose: (handler) => {
      if (closed) {
        handler();
        return () => {};
      }
      closeListeners.add(handler);
      return () => {
        closeListeners.delete(handler);
      };
    },
    close: () => {
      if (closed) return;
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore
      }
      notifyClose();
    },
  };
}
