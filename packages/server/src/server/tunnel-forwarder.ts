import net from "node:net";
import type pino from "pino";
import {
  TunnelCloseReason,
  TunnelStreamOpcode,
  encodeTunnelStreamFrame,
  type TunnelStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";

/**
 * Per-session raw-TCP port-forward.
 *
 * Each browser connection the client accepts on a forwarded loopback port maps
 * to one stream here. The client sends `Open(streamId, port)`, we dial
 * `127.0.0.1:port` on the daemon host and pipe bytes both ways as `Data` frames
 * over the session's existing binary channel; either side's EOF/`Close` tears
 * the stream down.
 *
 * Security: the target host is always `127.0.0.1` — the client only ever
 * supplies a port, never a host — so this can never become an open proxy to
 * arbitrary destinations. It is the in-product equivalent of `ssh -L`.
 */

/**
 * Pause the upstream socket once the client's send buffer passes this mark, and
 * resume when it drains below half. Mirrors the terminal pipeline's
 * MAX_CLIENT_BUFFERED_BYTES (see docs/terminal-performance.md). A `null` reading
 * means the transport exposes no backpressure signal (e.g. the multiplexed
 * relay socket); there we can't tell a slow client from a fast one, so we never
 * pause — dropping bytes is not an option for a TCP forward.
 */
const MAX_TUNNEL_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024;
const TUNNEL_BACKPRESSURE_POLL_MS = 25;

/** Cap concurrent streams per session so a buggy client can't exhaust sockets. */
const MAX_TUNNEL_STREAMS = 512;

interface TunnelStream {
  socket: net.Socket;
  connected: boolean;
  paused: boolean;
  drainPoll: ReturnType<typeof setInterval> | null;
}

export interface TunnelForwarderOptions {
  emitBinary: (frame: Uint8Array) => void;
  hasBinaryChannel: () => boolean;
  getClientBufferedAmount: () => number | null;
  sessionLogger: pino.Logger;
}

export class TunnelForwarder {
  private readonly streams = new Map<string, TunnelStream>();
  private readonly emitBinary: (frame: Uint8Array) => void;
  private readonly hasBinaryChannel: () => boolean;
  private readonly getClientBufferedAmount: () => number | null;
  private readonly logger: pino.Logger;
  private disposed = false;

  constructor(options: TunnelForwarderOptions) {
    this.emitBinary = options.emitBinary;
    this.hasBinaryChannel = options.hasBinaryChannel;
    this.getClientBufferedAmount = options.getClientBufferedAmount;
    this.logger = options.sessionLogger.child({ module: "tunnel-forwarder" });
  }

  handleFrame(frame: TunnelStreamFrame): void {
    if (this.disposed) {
      return;
    }
    switch (frame.opcode) {
      case TunnelStreamOpcode.Open:
        this.openStream(frame.streamId, frame.port);
        return;
      case TunnelStreamOpcode.Data:
        this.writeStream(frame.streamId, frame.payload);
        return;
      case TunnelStreamOpcode.Close:
        // The client closed the browser side; flush any queued request bytes to
        // the dev server (graceful FIN), and don't echo a Close back.
        this.closeStream(frame.streamId, { notifyClient: false, graceful: true });
        return;
    }
  }

  private openStream(streamId: string, port: number): void {
    if (!this.hasBinaryChannel()) {
      return;
    }
    if (this.streams.has(streamId)) {
      this.logger.warn({ streamId }, "Duplicate tunnel open ignored");
      return;
    }
    if (this.streams.size >= MAX_TUNNEL_STREAMS) {
      this.logger.warn({ streamId, port }, "Tunnel stream limit reached; rejecting open");
      this.sendClose(streamId, TunnelCloseReason.ConnectFailed);
      return;
    }

    const socket = net.connect({ host: "127.0.0.1", port });
    const stream: TunnelStream = { socket, connected: false, paused: false, drainPoll: null };
    this.streams.set(streamId, stream);

    socket.on("connect", () => {
      stream.connected = true;
    });
    socket.on("data", (chunk: Buffer) => {
      this.onSocketData(streamId, stream, chunk);
    });
    socket.on("end", () => {
      this.closeStream(streamId, { notifyClient: true, reason: TunnelCloseReason.Normal });
    });
    socket.on("close", () => {
      this.closeStream(streamId, { notifyClient: true, reason: TunnelCloseReason.Normal });
    });
    socket.on("error", (err: Error) => {
      const reason = stream.connected ? TunnelCloseReason.Normal : TunnelCloseReason.ConnectFailed;
      this.logger.debug({ err, streamId, port }, "Tunnel upstream socket error");
      this.closeStream(streamId, { notifyClient: true, reason });
    });
  }

  private writeStream(streamId: string, payload: Uint8Array): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }
    // Writes issued before 'connect' are queued by Node, so ordering holds.
    stream.socket.write(payload);
  }

  private onSocketData(streamId: string, stream: TunnelStream, chunk: Buffer): void {
    // The stream may have been closed (and half-closed via end()) while late
    // upstream bytes are still arriving; don't forward data for a gone stream.
    if (!this.streams.has(streamId) || !this.hasBinaryChannel()) {
      return;
    }
    this.emitBinary(
      encodeTunnelStreamFrame({ opcode: TunnelStreamOpcode.Data, streamId, payload: chunk }),
    );

    const buffered = this.getClientBufferedAmount();
    if (buffered !== null && buffered > MAX_TUNNEL_CLIENT_BUFFERED_BYTES && !stream.paused) {
      this.pauseStream(stream);
    }
  }

  private pauseStream(stream: TunnelStream): void {
    stream.paused = true;
    stream.socket.pause();
    stream.drainPoll = setInterval(() => {
      const buffered = this.getClientBufferedAmount();
      if (buffered === null || buffered <= MAX_TUNNEL_CLIENT_BUFFERED_BYTES / 2) {
        this.resumeStream(stream);
      }
    }, TUNNEL_BACKPRESSURE_POLL_MS);
  }

  private resumeStream(stream: TunnelStream): void {
    if (stream.drainPoll) {
      clearInterval(stream.drainPoll);
      stream.drainPoll = null;
    }
    if (stream.paused) {
      stream.paused = false;
      stream.socket.resume();
    }
  }

  private closeStream(
    streamId: string,
    options: { notifyClient: boolean; reason?: number; graceful?: boolean },
  ): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }
    this.streams.delete(streamId);
    if (stream.drainPoll) {
      clearInterval(stream.drainPoll);
      stream.drainPoll = null;
    }
    try {
      if (options.graceful) {
        // Flush queued writes, then FIN, so a request body isn't truncated.
        stream.socket.end();
      } else {
        stream.socket.destroy();
      }
    } catch {
      // ignore; teardown is best-effort
    }
    if (options.notifyClient) {
      this.sendClose(streamId, options.reason ?? TunnelCloseReason.Normal);
    }
  }

  private sendClose(streamId: string, reason: number): void {
    if (!this.hasBinaryChannel()) {
      return;
    }
    this.emitBinary(
      encodeTunnelStreamFrame({ opcode: TunnelStreamOpcode.Close, streamId, reason }),
    );
  }

  /** Tear down every stream. Called from Session.cleanup() on disconnect. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const stream of this.streams.values()) {
      if (stream.drainPoll) {
        clearInterval(stream.drainPoll);
        stream.drainPoll = null;
      }
      try {
        stream.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.streams.clear();
  }
}
