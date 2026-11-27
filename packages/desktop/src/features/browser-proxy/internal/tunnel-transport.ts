import {
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import {
  WSTunnelHandshakeResponseSchema,
  type WSTunnelHandshakeResponse,
} from "@getpaseo/protocol/messages";
import {
  openClientSecureChannel,
  type SecureChannel,
  type Transport as RelayClientTransport,
} from "@getpaseo/relay/e2ee";
import { WebSocket, type RawData } from "ws";
import { createSshProxy } from "../../../daemon/ssh-proxy.js";

export type BrowserProxyTarget =
  | {
      type: "directTcp";
      endpoint: string;
      useTls?: boolean;
    }
  | {
      type: "remoteSsh";
      host: string;
      sshPort?: number;
      daemonPort?: number;
    }
  | {
      type: "relay";
      serverId: string;
      relayEndpoint: string;
      useTls?: boolean;
      daemonPublicKeyB64: string;
      minimumSecurityMode?: "protected";
    };

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

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const WS_ENDPOINT_PATH = "/ws";

function rawDataToUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
  }
  return new Uint8Array(data);
}

function buildDirectTcpWebSocketUrl(
  target: Extract<BrowserProxyTarget, { type: "directTcp" }>,
): string {
  const trimmed = target.endpoint.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    throw new Error("Direct TCP endpoint is required");
  }
  if (/^wss?:\/\//iu.test(trimmed)) {
    return trimmed.endsWith(WS_ENDPOINT_PATH) ? trimmed : `${trimmed}${WS_ENDPOINT_PATH}`;
  }
  const scheme = target.useTls ? "wss" : "ws";
  return `${scheme}://${trimmed}${WS_ENDPOINT_PATH}`;
}

function waitForWebSocketOpen(
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

async function openPlainWebSocketTunnel(input: {
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

async function openRelayE2eeTunnel(input: {
  target: Extract<BrowserProxyTarget, { type: "relay" }>;
  ticket: string;
  timeoutMs: number;
}): Promise<TunnelWireConnection> {
  const wsUrl = buildRelayWebSocketUrl({
    endpoint: input.target.relayEndpoint,
    useTls: input.target.useTls ?? shouldUseTlsForDefaultHostedRelay(input.target.relayEndpoint),
    serverId: input.target.serverId,
    role: "client",
  });
  const rawWs = new WebSocket(wsUrl, { perMessageDeflate: false });
  await waitForWebSocketOpen(rawWs, input.timeoutMs);

  const binaryListeners = new Set<(bytes: Uint8Array) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let closed = false;
  let handshakeDone = false;
  let channel: SecureChannel | null = null;

  const notifyClose = (error?: Error) => {
    if (closed) return;
    closed = true;
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

  const transport: RelayClientTransport = {
    send: (data) =>
      new Promise<void>((resolve, reject) => {
        if (rawWs.readyState !== WebSocket.OPEN) {
          reject(new Error("Relay tunnel WebSocket is not open"));
          return;
        }
        rawWs.send(data, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    close: (code, reason) => {
      try {
        rawWs.close(code, reason);
      } catch {
        // ignore
      }
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  rawWs.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      transport.onmessage?.({ data: text, isBinary: false });
      return;
    }
    const bytes = rawDataToUint8Array(data);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    transport.onmessage?.({ data: copy.buffer, isBinary: true });
  });
  rawWs.on("close", (code, reason) => {
    const detail = reason.toString("utf8");
    transport.onclose?.(code, detail);
    const err = new Error(`Relay tunnel closed (${code}${detail ? `: ${detail}` : ""})`);
    if (!handshakeDone) {
      handshakeDone = true;
      rejectHandshake(err);
    }
    notifyClose(err);
  });
  rawWs.on("error", (error) => {
    transport.onerror?.(error);
    if (!handshakeDone) {
      handshakeDone = true;
      rejectHandshake(error);
    }
    notifyClose(error);
  });

  const handshakeTimer = setTimeout(() => {
    if (!handshakeDone) {
      handshakeDone = true;
      rejectHandshake(new Error("Timed out waiting for encrypted relay tunnel handshake"));
      try {
        rawWs.terminate();
      } catch {
        // ignore
      }
      notifyClose(new Error("Relay tunnel handshake timeout"));
    }
  }, input.timeoutMs);
  handshakeTimer.unref?.();

  try {
    channel = await openClientSecureChannel(transport, {
      daemonPublicKeyB64: input.target.daemonPublicKeyB64,
      ...(input.target.minimumSecurityMode
        ? { minimumMode: input.target.minimumSecurityMode }
        : {}),
      events: {
        onmessage: (data) => {
          if (!handshakeDone) {
            if (typeof data !== "string") {
              handshakeDone = true;
              clearTimeout(handshakeTimer);
              rejectHandshake(new Error("Received binary frame before tunnel_ready handshake"));
              channel?.close();
              return;
            }
            try {
              const parsed = WSTunnelHandshakeResponseSchema.parse(JSON.parse(data));
              handshakeDone = true;
              clearTimeout(handshakeTimer);
              resolveHandshake(parsed);
            } catch (error) {
              handshakeDone = true;
              clearTimeout(handshakeTimer);
              rejectHandshake(
                error instanceof Error ? error : new Error("Invalid tunnel handshake response"),
              );
              channel?.close();
            }
            return;
          }

          if (typeof data === "string") {
            return;
          }
          const bytes = new Uint8Array(data);
          for (const listener of binaryListeners) {
            listener(bytes);
          }
        },
        onclose: (code, reason) => {
          const err = new Error(`Relay E2EE tunnel closed (${code}${reason ? `: ${reason}` : ""})`);
          if (!handshakeDone) {
            handshakeDone = true;
            clearTimeout(handshakeTimer);
            rejectHandshake(err);
          }
          notifyClose(err);
        },
        onerror: (error) => {
          if (!handshakeDone) {
            handshakeDone = true;
            clearTimeout(handshakeTimer);
            rejectHandshake(error);
          }
          notifyClose(error);
        },
      },
    });

    await channel.send(JSON.stringify({ type: "tunnel_hello", ticket: input.ticket }));
    const handshake = await handshakePromise;
    clearTimeout(handshakeTimer);

    if (handshake.type === "tunnel_error") {
      channel.close();
      notifyClose(new TunnelHandshakeError(handshake.code, handshake.message));
      throw new TunnelHandshakeError(handshake.code, handshake.message);
    }

    const activeChannel = channel;
    return {
      ready: {
        maxFramePayloadBytes: handshake.maxFramePayloadBytes,
        initialStreamWindowBytes: handshake.initialStreamWindowBytes,
        initialConnectionWindowBytes: handshake.initialConnectionWindowBytes,
      },
      sendBinary: async (bytes) => {
        if (closed) {
          throw new Error("Relay tunnel channel is closed");
        }
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        await activeChannel.send(copy.buffer);
      },
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
          activeChannel.close();
        } catch {
          // ignore
        }
        notifyClose();
      },
    };
  } catch (error) {
    clearTimeout(handshakeTimer);
    try {
      channel?.close();
    } catch {
      // ignore
    }
    try {
      rawWs.close();
    } catch {
      // ignore
    }
    throw error;
  }
}

export async function openTunnelWireConnection(input: {
  target: BrowserProxyTarget;
  ticket: string;
  timeoutMs?: number;
}): Promise<TunnelWireConnection> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const { target, ticket } = input;

  if (target.type === "directTcp") {
    return await openPlainWebSocketTunnel({
      url: buildDirectTcpWebSocketUrl(target),
      ticket,
      timeoutMs,
    });
  }

  if (target.type === "remoteSsh") {
    const sshEndpoint = await createSshProxy({
      host: target.host,
      ...(target.sshPort !== undefined ? { sshPort: target.sshPort } : {}),
      ...(target.daemonPort !== undefined ? { daemonPort: target.daemonPort } : {}),
    });
    return await openPlainWebSocketTunnel({
      url: sshEndpoint.url,
      ticket,
      timeoutMs,
      cleanupTarget: sshEndpoint.close,
      getFailureDetail: sshEndpoint.failureDetail,
    });
  }

  return await openRelayE2eeTunnel({ target, ticket, timeoutMs });
}
