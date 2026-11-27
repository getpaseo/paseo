import type { Duplex } from "node:stream";
import {
  decodeNetworkTunnelFrame,
  encodeNetworkTunnelFrame,
  NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES,
  NetworkTunnelCloseReason,
  type DecodedNetworkTunnelFrame,
  type NetworkTunnelFrame,
} from "@getpaseo/protocol/network-tunnel";
import type { TunnelWireConnection } from "./tunnel-transport.js";

export type OpenTunnelStreamResult =
  | { ok: true }
  | { ok: false; reason: NetworkTunnelCloseReason; message?: string };

interface ActiveStream {
  readonly streamId: number;
  readonly socket: Duplex;
  state: "opening" | "open" | "closed";
  sendWindow: number;
  outboundQueue: Buffer[];
  socketPaused: boolean;
  localHalfClosed: boolean;
  localHalfCloseSent: boolean;
  remoteHalfClosed: boolean;
  recvConsumed: number;
  recvWindowLimit: number;
  pendingDrainBytes: number;
  pendingOpenResolve?: (result: OpenTunnelStreamResult) => void;
  onOpened?: () => void;
  cleanupSocketListeners?: () => void;
}

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

export interface TunnelMuxClientOptions {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export class TunnelMuxClient {
  private readonly streams = new Map<number, ActiveStream>();
  private readonly maxFramePayloadBytes: number;
  private readonly initialStreamWindowBytes: number;
  private readonly initialConnectionWindowBytes: number;
  private readonly heartbeatTimeoutMs: number;
  private sendConnWindow: number;
  private recvConnConsumed = 0;
  private nextStreamId = 1;
  private closed = false;
  private lastInboundAt = Date.now();
  private inboundFrameSeq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubBinary: () => void;
  private readonly unsubClose: () => void;
  private readonly closeListeners = new Set<(error?: Error) => void>();

  public constructor(
    private readonly wire: TunnelWireConnection,
    options?: TunnelMuxClientOptions,
  ) {
    this.maxFramePayloadBytes = Math.max(
      1,
      Math.min(wire.ready.maxFramePayloadBytes, NETWORK_TUNNEL_MAX_DATA_PAYLOAD_BYTES),
    );
    this.initialStreamWindowBytes = Math.max(1, wire.ready.initialStreamWindowBytes);
    this.initialConnectionWindowBytes = Math.max(1, wire.ready.initialConnectionWindowBytes);
    this.sendConnWindow = this.initialConnectionWindowBytes;

    const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

    this.unsubBinary = wire.onBinary((bytes) => {
      this.handleInboundBytes(bytes);
    });
    this.unsubClose = wire.onClose((error) => {
      this.handleWireClosed(error);
    });

    if (heartbeatIntervalMs > 0 && this.heartbeatTimeoutMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.closed) return;
        if (Date.now() - this.lastInboundAt >= this.heartbeatTimeoutMs) {
          const timeoutError = new Error("Tunnel heartbeat timed out");
          this.handleWireClosed(timeoutError);
          this.wire.close();
          return;
        }
        this.sendFrameBestEffort({ type: "ping" });
      }, heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public onClose(listener: (error?: Error) => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  public openStream(input: {
    host: string;
    port: number;
    socket: Duplex;
    initialData?: Buffer;
    onOpened?: () => void;
    timeoutMs?: number;
  }): Promise<OpenTunnelStreamResult> {
    if (this.closed) {
      return Promise.resolve({
        ok: false,
        reason: NetworkTunnelCloseReason.HostUnreachable,
        message: "Tunnel connection is closed",
      });
    }

    const streamId = this.allocateStreamId();
    const stream: ActiveStream = {
      streamId,
      socket: input.socket,
      state: "opening",
      sendWindow: 0,
      outboundQueue:
        input.initialData && input.initialData.length > 0 ? [Buffer.from(input.initialData)] : [],
      socketPaused: false,
      localHalfClosed: false,
      localHalfCloseSent: false,
      remoteHalfClosed: false,
      recvConsumed: 0,
      recvWindowLimit: this.initialStreamWindowBytes,
      pendingDrainBytes: 0,
      onOpened: input.onOpened,
    };

    this.streams.set(streamId, stream);

    let resolveOpen!: (result: OpenTunnelStreamResult) => void;
    const promise = new Promise<OpenTunnelStreamResult>((resolve) => {
      resolveOpen = resolve;
    });
    const timeoutMs = input.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    const finishOpen = (result: OpenTunnelStreamResult) => {
      if (!stream.pendingOpenResolve) return;
      clearTimeout(timer);
      stream.pendingOpenResolve = undefined;
      resolveOpen(result);
    };

    const openInboundSeq = this.inboundFrameSeq;
    const timer = setTimeout(() => {
      if (stream.state !== "opening") return;
      this.streams.delete(streamId);
      stream.state = "closed";
      this.sendFrameBestEffort({
        type: "close",
        streamId,
        reason: NetworkTunnelCloseReason.Timeout,
      });
      finishOpen({
        ok: false,
        reason: NetworkTunnelCloseReason.Timeout,
        message: "Timed out opening remote tunnel stream",
      });
      // If zero inbound frames arrived from the daemon during the entire open timeout,
      // treat the underlying tunnel wire as dead so the next request opens a fresh one.
      if (this.inboundFrameSeq === openInboundSeq) {
        const err = new Error("Tunnel became unresponsive during stream open");
        this.handleWireClosed(err);
        this.wire.close();
      }
    }, timeoutMs);
    timer.unref?.();

    stream.pendingOpenResolve = finishOpen;

    void this.sendFrame({
      type: "open",
      streamId,
      host: input.host,
      port: input.port,
    }).catch((error) => {
      if (stream.state !== "opening") return;
      this.streams.delete(streamId);
      stream.state = "closed";
      finishOpen({
        ok: false,
        reason: NetworkTunnelCloseReason.InternalError,
        message: error instanceof Error ? error.message : String(error),
      });
    });

    return promise;
  }

  public close(): void {
    if (this.closed) return;
    this.wire.close();
    this.handleWireClosed();
  }

  private allocateStreamId(): number {
    let id = this.nextStreamId;
    this.nextStreamId += 1;
    if (this.nextStreamId > 0xffffffff) {
      this.nextStreamId = 1;
    }
    while (id === 0 || this.streams.has(id)) {
      id = this.nextStreamId;
      this.nextStreamId += 1;
      if (this.nextStreamId > 0xffffffff) {
        this.nextStreamId = 1;
      }
    }
    return id;
  }

  private sendFrame(frame: NetworkTunnelFrame): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Tunnel mux is closed"));
    }
    return this.wire.sendBinary(encodeNetworkTunnelFrame(frame));
  }

  private sendFrameBestEffort(frame: NetworkTunnelFrame): void {
    if (this.closed) return;
    void this.sendFrame(frame).catch(() => {
      // Wire failure triggers handleWireClosed separately.
    });
  }

  private handleInboundBytes(bytes: Uint8Array): void {
    this.lastInboundAt = Date.now();
    this.inboundFrameSeq += 1;
    let frame: DecodedNetworkTunnelFrame;
    try {
      frame = decodeNetworkTunnelFrame(bytes);
    } catch (error) {
      this.wire.close();
      this.handleWireClosed(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    switch (frame.type) {
      case "ping":
        this.sendFrameBestEffort({ type: "pong", payload: frame.payload });
        return;

      case "pong":
        return;

      case "opened":
        this.handleOpened(frame);
        return;

      case "data":
        this.handleData(frame);
        return;

      case "window_update":
        this.handleWindowUpdate(frame);
        return;

      case "half_close":
        this.handleRemoteHalfClose(frame.streamId);
        return;

      case "close":
        this.handleRemoteClose(frame);
        return;

      case "open":
        // Client never accepts inbound Open frames.
        return;
    }
  }

  private handleOpened(frame: Extract<DecodedNetworkTunnelFrame, { type: "opened" }>): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream || stream.state !== "opening") {
      return;
    }
    stream.state = "open";
    stream.sendWindow = frame.initialWindowBytes;

    // Notify caller (writes SOCKS5 reply) BEFORE attaching inbound/outbound piping.
    try {
      stream.onOpened?.();
    } catch {
      this.closeStreamLocally(stream, NetworkTunnelCloseReason.InternalError);
      stream.pendingOpenResolve?.({
        ok: false,
        reason: NetworkTunnelCloseReason.InternalError,
      });
      return;
    }

    this.attachSocketToStream(stream);
    stream.pendingOpenResolve?.({ ok: true });
    this.flushOutbound(stream);
  }

  private attachSocketToStream(stream: ActiveStream): void {
    const { socket } = stream;

    const onData = (chunk: Buffer | string) => {
      if (stream.state !== "open") return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length === 0) return;
      stream.outboundQueue.push(buf);
      this.flushOutbound(stream);
    };

    const onDrain = () => {
      if (this.closed || stream.state !== "open") return;
      if (stream.pendingDrainBytes > 0) {
        const drained = stream.pendingDrainBytes;
        stream.pendingDrainBytes = 0;
        this.recordInboundConsumed(stream, drained);
      }
    };

    const onEnd = () => {
      if (stream.state !== "open" || stream.localHalfClosed) return;
      stream.localHalfClosed = true;
      this.flushOutbound(stream);
    };

    const onError = () => {
      this.closeStreamLocally(stream, NetworkTunnelCloseReason.Reset);
    };

    const onClose = () => {
      if (stream.state === "open") {
        this.closeStreamLocally(
          stream,
          stream.localHalfClosed && stream.remoteHalfClosed
            ? NetworkTunnelCloseReason.Normal
            : NetworkTunnelCloseReason.Reset,
        );
      }
    };

    socket.on("data", onData);
    socket.on("drain", onDrain);
    socket.on("end", onEnd);
    socket.on("error", onError);
    socket.on("close", onClose);

    stream.cleanupSocketListeners = () => {
      socket.off("data", onData);
      socket.off("drain", onDrain);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
  }

  private flushOutbound(stream: ActiveStream): void {
    if (stream.state !== "open" || this.closed) {
      return;
    }

    while (stream.outboundQueue.length > 0) {
      const available = Math.min(stream.sendWindow, this.sendConnWindow, this.maxFramePayloadBytes);
      if (available <= 0) {
        if (!stream.socketPaused) {
          stream.socketPaused = true;
          stream.socket.pause();
        }
        return;
      }

      const head = stream.outboundQueue[0]!;
      let slice: Buffer;
      if (head.length <= available) {
        slice = stream.outboundQueue.shift()!;
      } else {
        slice = head.subarray(0, available);
        stream.outboundQueue[0] = head.subarray(available);
      }

      stream.sendWindow -= slice.length;
      this.sendConnWindow -= slice.length;

      this.sendFrameBestEffort({
        type: "data",
        streamId: stream.streamId,
        data: slice,
      });
    }

    if (stream.socketPaused && stream.sendWindow > 0 && this.sendConnWindow > 0) {
      stream.socketPaused = false;
      stream.socket.resume();
    }

    if (stream.localHalfClosed && !stream.localHalfCloseSent && stream.outboundQueue.length === 0) {
      stream.localHalfCloseSent = true;
      this.sendFrameBestEffort({
        type: "half_close",
        streamId: stream.streamId,
      });
      if (stream.remoteHalfClosed) {
        this.closeStreamLocally(stream, NetworkTunnelCloseReason.Normal);
      }
    }
  }

  private flushAllOutbound(): void {
    for (const stream of this.streams.values()) {
      if (stream.state === "open") {
        this.flushOutbound(stream);
      }
    }
  }

  private handleData(frame: Extract<DecodedNetworkTunnelFrame, { type: "data" }>): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream || stream.state !== "open") {
      return;
    }
    if (frame.data.byteLength === 0) {
      return;
    }
    if (stream.socket.destroyed || !stream.socket.writable) {
      this.closeStreamLocally(stream, NetworkTunnelCloseReason.Reset);
      return;
    }

    const byteLength = frame.data.byteLength;
    const canContinue = stream.socket.write(frame.data);
    if (canContinue && stream.pendingDrainBytes === 0) {
      this.recordInboundConsumed(stream, byteLength);
    } else {
      stream.pendingDrainBytes += byteLength;
    }
  }

  private flushConnectionRecvWindow(): void {
    if (this.closed) return;

    const connThreshold = Math.max(1, Math.floor(this.initialConnectionWindowBytes / 2));
    if (this.recvConnConsumed >= connThreshold) {
      const credit = this.recvConnConsumed;
      this.recvConnConsumed = 0;
      this.sendFrameBestEffort({
        type: "window_update",
        streamId: 0,
        creditBytes: credit,
      });
    }
  }

  private recordInboundConsumed(stream: ActiveStream, bytes: number): void {
    if (this.closed) return;

    this.recvConnConsumed += bytes;
    this.flushConnectionRecvWindow();

    if (stream.state === "open") {
      stream.recvConsumed += bytes;
      const streamThreshold = Math.max(1, Math.floor(stream.recvWindowLimit / 2));
      if (stream.recvConsumed >= streamThreshold) {
        const credit = stream.recvConsumed;
        stream.recvConsumed = 0;
        this.sendFrameBestEffort({
          type: "window_update",
          streamId: stream.streamId,
          creditBytes: credit,
        });
      }
    }
  }

  private handleWindowUpdate(
    frame: Extract<DecodedNetworkTunnelFrame, { type: "window_update" }>,
  ): void {
    if (frame.streamId === 0) {
      this.sendConnWindow += frame.creditBytes;
      this.flushAllOutbound();
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream || stream.state !== "open") {
      return;
    }
    stream.sendWindow += frame.creditBytes;
    this.flushOutbound(stream);
  }

  private handleRemoteHalfClose(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.state !== "open") {
      return;
    }
    stream.remoteHalfClosed = true;
    if (!stream.socket.destroyed && stream.socket.writable) {
      stream.socket.end();
    }
    if (stream.localHalfCloseSent) {
      this.cleanupStream(stream);
    }
  }

  private handleRemoteClose(frame: Extract<DecodedNetworkTunnelFrame, { type: "close" }>): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      return;
    }
    if (stream.state === "opening") {
      this.streams.delete(frame.streamId);
      stream.state = "closed";
      stream.pendingOpenResolve?.({
        ok: false,
        reason: frame.reason,
        ...(frame.message !== undefined ? { message: frame.message } : {}),
      });
      return;
    }
    this.cleanupStream(stream);
    if (!stream.socket.destroyed) {
      if (frame.reason === NetworkTunnelCloseReason.Normal) {
        stream.socket.end();
      } else {
        stream.socket.destroy();
      }
    }
  }

  private closeStreamLocally(stream: ActiveStream, reason: NetworkTunnelCloseReason): void {
    if (stream.state === "closed") {
      return;
    }
    const streamId = stream.streamId;
    this.cleanupStream(stream);
    this.sendFrameBestEffort({
      type: "close",
      streamId,
      reason,
    });
  }

  private cleanupStream(stream: ActiveStream): void {
    if (stream.state === "closed") {
      return;
    }
    stream.state = "closed";
    stream.outboundQueue.length = 0;
    stream.cleanupSocketListeners?.();
    stream.cleanupSocketListeners = undefined;
    this.streams.delete(stream.streamId);

    // Never leak connection-level receive credit when a stream closes with un-drained bytes.
    if (stream.pendingDrainBytes > 0) {
      this.recvConnConsumed += stream.pendingDrainBytes;
      stream.pendingDrainBytes = 0;
      this.flushConnectionRecvWindow();
    }
  }

  private handleWireClosed(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.unsubBinary();
    this.unsubClose();

    for (const stream of this.streams.values()) {
      const wasOpening = stream.state === "opening";
      this.cleanupStream(stream);
      if (wasOpening) {
        stream.pendingOpenResolve?.({
          ok: false,
          reason: NetworkTunnelCloseReason.HostUnreachable,
          message: error?.message ?? "Tunnel connection closed",
        });
      } else if (!stream.socket.destroyed) {
        stream.socket.destroy();
      }
    }

    for (const listener of this.closeListeners) {
      listener(error);
    }
    this.closeListeners.clear();
  }
}
