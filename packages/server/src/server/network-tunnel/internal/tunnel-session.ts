import { Socket } from "node:net";
import type pino from "pino";
import {
  decodeNetworkTunnelFrame,
  encodeNetworkTunnelFrame,
  NETWORK_TUNNEL_DEFAULT_INITIAL_CONNECTION_WINDOW_BYTES,
  NETWORK_TUNNEL_DEFAULT_INITIAL_STREAM_WINDOW_BYTES,
  NETWORK_TUNNEL_MAX_CONCURRENT_STREAMS,
  NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES,
  NetworkTunnelCloseReason,
  NetworkTunnelCodecError,
  type DecodedNetworkTunnelFrame,
  type NetworkTunnelFrame,
} from "@getpaseo/protocol/network-tunnel";
import type { WSTunnelReadyMessage } from "@getpaseo/protocol/messages";
import { sendBoundedPhysicalFrame } from "../../websocket/physical-socket.js";
import {
  resolveAndValidateTunnelDestination,
  type HostResolver,
  type ResolvedAddress,
} from "./destination-policy.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 15_000;
const MAX_WINDOW_BYTES = 0x7fffffff;

export interface TunnelSocketLike {
  readyState: number;
  bufferedAmount?: number;
  send: (
    data: string | Uint8Array | ArrayBuffer,
    callback?: (error?: Error) => void,
  ) => void | Promise<void>;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

export interface TunnelSessionOptions {
  ws: TunnelSocketLike;
  principalId: string;
  logger: pino.Logger;
  maxConcurrentStreams?: number;
  maxFramePayloadBytes?: number;
  initialStreamWindowBytes?: number;
  initialConnectionWindowBytes?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
  resolveHost?: HostResolver;
  onClose?: () => void;
}

interface TunnelStreamState {
  readonly streamId: number;
  state: "connecting" | "open" | "closed";
  socket: Socket | null;
  sendWindowBytes: number;
  recvWindowBytes: number;
  uncreditedRecvBytes: number;
  pendingDrainBytes: number;
  pendingOutboundChunks: Uint8Array[];
  pendingOutboundBytes: number;
  remoteEnded: boolean;
  remoteHalfCloseSent: boolean;
  clientHalfClosed: boolean;
  tcpPaused: boolean;
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    const buffers: Buffer[] = [];
    for (const part of data) {
      if (Buffer.isBuffer(part)) {
        buffers.push(part);
      } else if (part instanceof ArrayBuffer) {
        buffers.push(Buffer.from(part));
      } else if (ArrayBuffer.isView(part)) {
        buffers.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      } else {
        return null;
      }
    }
    const merged = Buffer.concat(buffers);
    return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  }
  return null;
}

function mapPolicyCodeToCloseReason(
  code: "policy_denied" | "dns_failed" | "invalid_destination",
): NetworkTunnelCloseReason {
  if (code === "policy_denied") return NetworkTunnelCloseReason.PolicyDenied;
  if (code === "dns_failed") return NetworkTunnelCloseReason.DnsFailed;
  return NetworkTunnelCloseReason.ProtocolError;
}

function mapErrnoToCloseReason(error: unknown): NetworkTunnelCloseReason {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ECONNREFUSED":
      return NetworkTunnelCloseReason.ConnectRefused;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EADDRNOTAVAIL":
      return NetworkTunnelCloseReason.HostUnreachable;
    case "ETIMEDOUT":
      return NetworkTunnelCloseReason.Timeout;
    case "ECONNRESET":
    case "EPIPE":
      return NetworkTunnelCloseReason.Reset;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return NetworkTunnelCloseReason.DnsFailed;
    default:
      return NetworkTunnelCloseReason.InternalError;
  }
}

export class TunnelSession {
  readonly principalId: string;
  private readonly ws: TunnelSocketLike;
  private readonly logger: pino.Logger;
  private readonly maxConcurrentStreams: number;
  private readonly maxFramePayloadBytes: number;
  private readonly initialStreamWindowBytes: number;
  private readonly initialConnectionWindowBytes: number;
  private readonly streamWindowUpdateThreshold: number;
  private readonly connectionWindowUpdateThreshold: number;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly resolveHost: HostResolver | undefined;
  private readonly onCloseCallback: (() => void) | undefined;

  private readonly streams = new Map<number, TunnelStreamState>();
  private connectionSendWindowBytes: number;
  private connectionRecvWindowBytes: number;
  private uncreditedConnectionRecvBytes = 0;
  private lastInboundAt = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: TunnelSessionOptions) {
    this.ws = options.ws;
    this.principalId = options.principalId;
    this.logger = options.logger.child({ module: "network-tunnel-session" });
    this.maxConcurrentStreams =
      options.maxConcurrentStreams ?? NETWORK_TUNNEL_MAX_CONCURRENT_STREAMS;
    this.maxFramePayloadBytes =
      options.maxFramePayloadBytes ?? NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES;
    this.initialStreamWindowBytes =
      options.initialStreamWindowBytes ?? NETWORK_TUNNEL_DEFAULT_INITIAL_STREAM_WINDOW_BYTES;
    this.initialConnectionWindowBytes =
      options.initialConnectionWindowBytes ??
      NETWORK_TUNNEL_DEFAULT_INITIAL_CONNECTION_WINDOW_BYTES;
    this.streamWindowUpdateThreshold = Math.max(1, Math.floor(this.initialStreamWindowBytes / 4));
    this.connectionWindowUpdateThreshold = Math.max(
      1,
      Math.floor(this.initialConnectionWindowBytes / 4),
    );
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const idleCheckIntervalMs =
      options.idleCheckIntervalMs ??
      Math.min(DEFAULT_IDLE_CHECK_INTERVAL_MS, Math.max(10, Math.floor(this.idleTimeoutMs / 3)));
    this.resolveHost = options.resolveHost;
    this.onCloseCallback = options.onClose;

    this.connectionSendWindowBytes = this.initialConnectionWindowBytes;
    this.connectionRecvWindowBytes = this.initialConnectionWindowBytes;

    this.bindSocket();
    this.sendReadyHandshake();

    if (!this.closed && this.idleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => {
        if (this.closed) return;
        if (Date.now() - this.lastInboundAt >= this.idleTimeoutMs) {
          this.logger.warn(
            { idleTimeoutMs: this.idleTimeoutMs },
            "Closing idle network tunnel session after liveness timeout",
          );
          this.close(1001, "Tunnel liveness timeout");
        }
      }, idleCheckIntervalMs);
      this.idleTimer.unref?.();
    }
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(code = 1000, reason = "Tunnel closed"): void {
    if (this.closed) return;
    this.teardown();
    try {
      if (this.ws.readyState === 1) {
        this.ws.close(code, reason);
      }
    } catch {
      // ignore close errors on already-closing transport
    }
  }

  private bindSocket(): void {
    this.ws.on("message", (...args: unknown[]) => {
      if (this.closed) return;
      const data = args[0];
      const isBinaryArg = args[1];
      const isBinary =
        isBinaryArg === true || (isBinaryArg === undefined && typeof data !== "string");
      if (!isBinary) {
        this.logger.warn("Received non-binary frame on active tunnel socket; closing");
        this.close(1002, "Expected binary tunnel frame");
        return;
      }
      const bytes = toUint8Array(data);
      if (!bytes) {
        this.close(1002, "Invalid binary tunnel frame");
        return;
      }
      let frame: DecodedNetworkTunnelFrame;
      try {
        frame = decodeNetworkTunnelFrame(bytes);
      } catch (error) {
        const message =
          error instanceof NetworkTunnelCodecError ? error.message : "Invalid tunnel frame";
        this.logger.warn({ err: error }, "Malformed tunnel frame; closing tunnel");
        this.close(1002, message);
        return;
      }
      this.lastInboundAt = Date.now();
      this.handleFrame(frame);
    });

    this.ws.on("close", () => {
      this.teardown();
    });

    this.ws.on("error", (error: unknown) => {
      this.logger.warn({ err: error }, "Tunnel WebSocket error");
      this.teardown();
    });
  }

  private sendReadyHandshake(): void {
    const ready: WSTunnelReadyMessage = {
      type: "tunnel_ready",
      maxFramePayloadBytes: this.maxFramePayloadBytes,
      initialStreamWindowBytes: this.initialStreamWindowBytes,
      initialConnectionWindowBytes: this.initialConnectionWindowBytes,
    };
    const ok = sendBoundedPhysicalFrame({
      socket: this.ws,
      frame: JSON.stringify(ready),
      onHighWater: () => this.terminateForHighWater(),
    });
    if (!ok) {
      this.teardown();
    }
  }

  private sendFrame(frame: NetworkTunnelFrame): boolean {
    if (this.closed || this.ws.readyState !== 1) return false;
    const encoded = encodeNetworkTunnelFrame(frame);
    const ok = sendBoundedPhysicalFrame({
      socket: this.ws,
      frame: encoded,
      frameBytes: encoded.byteLength,
      onHighWater: () => this.terminateForHighWater(),
    });
    if (!ok) {
      this.teardown();
    }
    return ok;
  }

  private terminateForHighWater(): void {
    this.logger.warn("Terminating tunnel WebSocket at outbound high-water mark");
    this.teardown();
    try {
      if (this.ws.terminate) {
        this.ws.terminate();
      } else {
        this.ws.close(1008, "Outbound buffer limit exceeded");
      }
    } catch {
      // ignore
    }
  }

  private handleFrame(frame: DecodedNetworkTunnelFrame): void {
    switch (frame.type) {
      case "ping":
        this.sendFrame({ type: "pong", payload: frame.payload });
        return;

      case "pong":
        return;

      case "open":
        void this.handleOpen(frame.streamId, frame.host, frame.port);
        return;

      case "data":
        this.handleInboundData(frame.streamId, frame.data);
        return;

      case "window_update":
        this.handleWindowUpdate(frame.streamId, frame.creditBytes);
        return;

      case "half_close":
        this.handleClientHalfClose(frame.streamId);
        return;

      case "close":
        this.handleClientClose(frame.streamId);
        return;

      case "opened":
        // Client must never send Opened to daemon.
        this.close(1002, "Unexpected Opened frame from client");
        return;
    }
  }

  private async handleOpen(streamId: number, host: string, port: number): Promise<void> {
    if (this.closed) return;

    if (this.streams.has(streamId)) {
      this.sendFrame({
        type: "close",
        streamId,
        reason: NetworkTunnelCloseReason.ProtocolError,
        message: `Duplicate streamId ${streamId}`,
      });
      return;
    }

    if (this.streams.size >= this.maxConcurrentStreams) {
      this.sendFrame({
        type: "close",
        streamId,
        reason: NetworkTunnelCloseReason.StreamLimitExceeded,
        message: `Max concurrent streams (${this.maxConcurrentStreams}) exceeded`,
      });
      return;
    }

    // Reserve stream slot before async DNS resolution so burst Opens cannot bypass the cap.
    const stream: TunnelStreamState = {
      streamId,
      state: "connecting",
      socket: null,
      sendWindowBytes: this.initialStreamWindowBytes,
      recvWindowBytes: this.initialStreamWindowBytes,
      uncreditedRecvBytes: 0,
      pendingDrainBytes: 0,
      pendingOutboundChunks: [],
      pendingOutboundBytes: 0,
      remoteEnded: false,
      remoteHalfCloseSent: false,
      clientHalfClosed: false,
      tcpPaused: false,
    };
    this.streams.set(streamId, stream);

    const resolution = await resolveAndValidateTunnelDestination(host, port, this.resolveHost);
    if (this.isStreamInactive(stream)) {
      return;
    }

    if (!resolution.ok) {
      const reason = mapPolicyCodeToCloseReason(resolution.code);
      this.cleanupStream(stream);
      this.sendFrame({
        type: "close",
        streamId,
        reason,
        message: resolution.message,
      });
      return;
    }

    try {
      const socket = await this.dialValidatedAddresses(
        stream,
        resolution.addresses,
        resolution.port,
      );
      if (this.isStreamInactive(stream)) {
        socket.destroy();
        return;
      }

      stream.state = "open";
      stream.socket = socket;
      socket.setNoDelay(true);
      this.attachTcpSocketHandlers(stream, socket);

      this.sendFrame({
        type: "opened",
        streamId,
        initialWindowBytes: this.initialStreamWindowBytes,
      });
    } catch (error) {
      if (this.isStreamInactive(stream)) {
        return;
      }
      const reason = mapErrnoToCloseReason(error);
      const message = error instanceof Error ? error.message : String(error);
      this.cleanupStream(stream);
      this.sendFrame({
        type: "close",
        streamId,
        reason,
        message,
      });
    }
  }

  private isStreamInactive(stream: TunnelStreamState): boolean {
    return this.closed || stream.state === "closed" || this.streams.get(stream.streamId) !== stream;
  }

  private async dialValidatedAddresses(
    stream: TunnelStreamState,
    addresses: ResolvedAddress[],
    port: number,
  ): Promise<Socket> {
    let lastError: unknown = new Error("No addresses to dial");
    const deadlineMs = Date.now() + this.connectTimeoutMs;

    for (const entry of addresses) {
      if (this.closed || stream.state === "closed") {
        throw new Error("Stream closed during connect");
      }
      const remainingMs = Math.max(100, deadlineMs - Date.now());
      try {
        return await this.dialSingleAddress(stream, entry, port, remainingMs);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  private dialSingleAddress(
    stream: TunnelStreamState,
    address: ResolvedAddress,
    port: number,
    timeoutMs: number,
  ): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = new Socket({ allowHalfOpen: true });
      stream.socket = socket;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        const err = new Error(
          `TCP connect timed out after ${timeoutMs}ms`,
        ) as NodeJS.ErrnoException;
        err.code = "ETIMEDOUT";
        reject(err);
      }, timeoutMs);

      const finish = (cb: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        cb();
      };

      const onConnect = () => finish(() => resolve(socket));
      const onError = (err: Error) =>
        finish(() => {
          socket.destroy();
          reject(err);
        });
      const onClose = () =>
        finish(() => {
          reject(new Error("TCP socket closed before connect completed"));
        });

      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);

      // Pass the already-validated IP directly with a pinned lookup callback so Node never re-resolves DNS.
      socket.connect({
        host: address.address,
        port,
        family: address.family,
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        },
      });
    });
  }

  private attachTcpSocketHandlers(stream: TunnelStreamState, socket: Socket): void {
    socket.on("data", (chunk: Buffer) => {
      if (this.closed || stream.state !== "open") return;
      if (chunk.byteLength === 0) return;
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      stream.pendingOutboundChunks.push(bytes.slice());
      stream.pendingOutboundBytes += bytes.byteLength;
      this.flushStreamOutbound(stream);
    });

    socket.on("drain", () => {
      if (this.closed || stream.state !== "open") return;
      if (stream.pendingDrainBytes > 0) {
        const drained = stream.pendingDrainBytes;
        stream.pendingDrainBytes = 0;
        this.creditInboundConsumed(stream, drained);
      }
    });

    socket.on("end", () => {
      if (this.closed || stream.state !== "open") return;
      stream.remoteEnded = true;
      this.flushStreamOutbound(stream);
    });

    socket.on("error", (error: Error) => {
      if (this.closed || stream.state === "closed") return;
      const reason = mapErrnoToCloseReason(error);
      this.cleanupStream(stream);
      this.sendFrame({
        type: "close",
        streamId: stream.streamId,
        reason,
        message: error.message,
      });
    });

    socket.on("close", (hadError: boolean) => {
      if (this.closed || stream.state === "closed") return;
      if (!hadError && stream.remoteEnded && stream.pendingOutboundBytes > 0) {
        // TCP FIN arrived; keep draining buffered outbound chunks until credit lets us flush them.
        return;
      }
      const reason = hadError
        ? NetworkTunnelCloseReason.Reset
        : NetworkTunnelCloseReason.RemoteClosed;
      this.cleanupStream(stream);
      this.sendFrame({
        type: "close",
        streamId: stream.streamId,
        reason,
      });
    });
  }

  private flushStreamOutbound(stream: TunnelStreamState): void {
    if (this.closed || stream.state !== "open") return;

    while (
      stream.pendingOutboundChunks.length > 0 &&
      stream.sendWindowBytes > 0 &&
      this.connectionSendWindowBytes > 0
    ) {
      const budget = Math.min(
        this.maxFramePayloadBytes,
        stream.sendWindowBytes,
        this.connectionSendWindowBytes,
      );
      const head = stream.pendingOutboundChunks[0]!;
      let slice: Uint8Array;
      if (head.byteLength <= budget) {
        slice = head;
        stream.pendingOutboundChunks.shift();
      } else {
        slice = head.subarray(0, budget);
        stream.pendingOutboundChunks[0] = head.subarray(budget);
      }
      stream.pendingOutboundBytes -= slice.byteLength;
      stream.sendWindowBytes -= slice.byteLength;
      this.connectionSendWindowBytes -= slice.byteLength;

      if (!this.sendFrame({ type: "data", streamId: stream.streamId, data: slice })) {
        return;
      }
    }

    if (stream.pendingOutboundBytes > 0) {
      this.pauseStreamSocket(stream);
      return;
    }

    this.resumeStreamSocketIfReady(stream);
    this.maybeSendRemoteHalfClose(stream);
  }

  private pauseStreamSocket(stream: TunnelStreamState): void {
    if (!stream.tcpPaused && stream.socket && !stream.socket.destroyed) {
      stream.tcpPaused = true;
      stream.socket.pause();
    }
  }

  private resumeStreamSocketIfReady(stream: TunnelStreamState): void {
    const hasCredit = stream.sendWindowBytes > 0 && this.connectionSendWindowBytes > 0;
    if (
      stream.tcpPaused &&
      !stream.remoteEnded &&
      hasCredit &&
      stream.socket &&
      !stream.socket.destroyed
    ) {
      stream.tcpPaused = false;
      stream.socket.resume();
    }
  }

  private maybeSendRemoteHalfClose(stream: TunnelStreamState): void {
    // Deliver HalfClose only after all queued TCP data has been sent in order.
    if (stream.remoteEnded && !stream.remoteHalfCloseSent) {
      stream.remoteHalfCloseSent = true;
      this.sendFrame({ type: "half_close", streamId: stream.streamId });
      if (stream.clientHalfClosed) {
        this.cleanupStream(stream);
      }
    }
  }

  private flushAllOutbound(): void {
    if (this.closed || this.connectionSendWindowBytes <= 0) return;
    // Iterate in insertion order; if connection window exhausts mid-way, remaining streams stay paused.
    for (const stream of Array.from(this.streams.values())) {
      if (this.closed) return;
      if (stream.state === "open") {
        this.flushStreamOutbound(stream);
      }
      if (this.connectionSendWindowBytes <= 0) break;
    }
  }

  private handleInboundData(streamId: number, data: Uint8Array): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.state !== "open" || !stream.socket) {
      this.sendFrame({
        type: "close",
        streamId,
        reason: NetworkTunnelCloseReason.ProtocolError,
        message: `Data for unknown or unopened stream ${streamId}`,
      });
      return;
    }
    if (stream.clientHalfClosed) {
      this.cleanupStream(stream);
      this.sendFrame({
        type: "close",
        streamId,
        reason: NetworkTunnelCloseReason.ProtocolError,
        message: `Data received after HalfClose on stream ${streamId}`,
      });
      return;
    }

    const len = data.byteLength;
    if (len > this.connectionRecvWindowBytes) {
      this.close(1008, "Connection receive window exceeded");
      return;
    }
    if (len > stream.recvWindowBytes) {
      this.cleanupStream(stream);
      this.sendFrame({
        type: "close",
        streamId,
        reason: NetworkTunnelCloseReason.FlowControlError,
        message: `Stream ${streamId} receive window exceeded`,
      });
      return;
    }

    if (len === 0) return;

    stream.recvWindowBytes -= len;
    this.connectionRecvWindowBytes -= len;

    const accepted = stream.socket.write(data);
    if (accepted && stream.pendingDrainBytes === 0) {
      this.creditInboundConsumed(stream, len);
    } else {
      stream.pendingDrainBytes += len;
    }
  }

  private creditInboundConsumed(stream: TunnelStreamState, bytes: number): void {
    stream.uncreditedRecvBytes += bytes;
    this.uncreditedConnectionRecvBytes += bytes;

    if (stream.state === "open" && stream.uncreditedRecvBytes >= this.streamWindowUpdateThreshold) {
      const grant = stream.uncreditedRecvBytes;
      stream.uncreditedRecvBytes = 0;
      stream.recvWindowBytes += grant;
      this.sendFrame({ type: "window_update", streamId: stream.streamId, creditBytes: grant });
    }

    this.maybeFlushConnectionRecvWindow();
  }

  private maybeFlushConnectionRecvWindow(): void {
    if (this.uncreditedConnectionRecvBytes >= this.connectionWindowUpdateThreshold) {
      const grant = this.uncreditedConnectionRecvBytes;
      this.uncreditedConnectionRecvBytes = 0;
      this.connectionRecvWindowBytes += grant;
      this.sendFrame({ type: "window_update", streamId: 0, creditBytes: grant });
    }
  }

  private handleWindowUpdate(streamId: number, creditBytes: number): void {
    if (streamId === 0) {
      if (this.connectionSendWindowBytes + creditBytes > MAX_WINDOW_BYTES) {
        this.close(1008, "Connection send window overflow");
        return;
      }
      this.connectionSendWindowBytes += creditBytes;
      this.flushAllOutbound();
      return;
    }

    const stream = this.streams.get(streamId);
    if (!stream || stream.state !== "open") {
      // Late window updates for an already-closed stream are harmless; ignore.
      return;
    }
    if (stream.sendWindowBytes + creditBytes > MAX_WINDOW_BYTES) {
      this.cleanupStream(stream);
      this.sendFrame({
        type: "close",
        streamId,
        reason: NetworkTunnelCloseReason.FlowControlError,
        message: `Stream ${streamId} send window overflow`,
      });
      return;
    }
    stream.sendWindowBytes += creditBytes;
    this.flushStreamOutbound(stream);
  }

  private handleClientHalfClose(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.state !== "open" || !stream.socket) {
      return;
    }
    if (stream.clientHalfClosed) return;
    stream.clientHalfClosed = true;
    stream.socket.end();
    if (stream.remoteHalfCloseSent) {
      this.cleanupStream(stream);
    }
  }

  private handleClientClose(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.cleanupStream(stream);
  }

  private cleanupStream(stream: TunnelStreamState): void {
    if (stream.state === "closed") return;
    stream.state = "closed";
    this.streams.delete(stream.streamId);
    stream.pendingOutboundChunks.length = 0;
    stream.pendingOutboundBytes = 0;

    // Never leak connection-level receive credit when a stream closes with un-drained bytes.
    if (stream.pendingDrainBytes > 0) {
      this.uncreditedConnectionRecvBytes += stream.pendingDrainBytes;
      stream.pendingDrainBytes = 0;
      if (!this.closed) {
        this.maybeFlushConnectionRecvWindow();
      }
    }

    const socket = stream.socket;
    stream.socket = null;
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const stream of Array.from(this.streams.values())) {
      this.cleanupStream(stream);
    }
    this.streams.clear();
    this.onCloseCallback?.();
  }
}
