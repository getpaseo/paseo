import {
  encodeTunnelFrame,
  TunnelCloseReason,
  TunnelOpcode,
  type TunnelFrame,
  type TunnelCloseReason as TunnelCloseReasonCode,
  type TunnelTarget,
} from "@getpaseo/protocol/binary-frames/index";
import {
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_STREAMS,
  type NetworkTunnelClosedReason as DaemonNetworkTunnelClosedReason,
  type NetworkTunnelLimits as AnnouncedNetworkTunnelLimits,
} from "@getpaseo/protocol/network-tunnel/rpc-schemas";

const RECENT_TUNNEL_ID_LIMIT = 2048;

export interface NetworkTunnelLimits {
  initialWindowBytes: number;
  maxDataBytes: number;
  maxStreams: number;
  connectTimeoutMs: number;
}

export type NetworkTunnelClosedReason = "closed" | "disconnected" | "protocol_error";

export interface NetworkTunnelStreamHandlers {
  onConnected(): void;
  onData(data: Uint8Array): void;
  onCredit(credit: number): void;
  onClose(reason: number): void;
}

export interface NetworkTunnelStream {
  readonly streamId: string;
  write(data: Uint8Array): void;
  consume(bytes: number): void;
  close(reason?: number): void;
}

export interface NetworkTunnelTarget {
  streamId?: string;
  host: string;
  port: number;
}

export interface NetworkTunnel {
  readonly subscriptionId: string;
  readonly limits: NetworkTunnelLimits;
  openStream(
    target: NetworkTunnelTarget,
    handlers: NetworkTunnelStreamHandlers,
  ): NetworkTunnelStream;
  close(): Promise<void>;
  onClosed(listener: (reason: NetworkTunnelClosedReason) => void): () => void;
}

export type NetworkTunnelErrorCode =
  | "closed"
  | "duplicate_stream"
  | "invalid_consumption"
  | "invalid_state"
  | "max_data_exceeded"
  | "no_credit"
  | "protocol_error"
  | "stream_limit";

export class NetworkTunnelError extends Error {
  constructor(
    readonly code: NetworkTunnelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NetworkTunnelError";
  }
}

export class NetworkTunnelRpcError extends Error {
  constructor(
    readonly operation: "open" | "close",
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NetworkTunnelRpcError";
  }
}

interface NetworkTunnelConnection {
  send(frame: Uint8Array): void;
  close(subscriptionId: string): Promise<void>;
  createStreamId(): string;
  closeProtocolViolation(subscriptionId: string): void;
  handlerError(error: unknown, handler: string): void;
}

type StreamState = "connecting" | "connected" | "closed";

class RecentIds {
  private readonly ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size <= RECENT_TUNNEL_ID_LIMIT) return;
    const oldest = this.ids.values().next().value;
    if (oldest) this.ids.delete(oldest);
  }

  clear(): void {
    this.ids.clear();
  }
}

function applyClientLimits(announced: AnnouncedNetworkTunnelLimits): NetworkTunnelLimits {
  return {
    initialWindowBytes: Math.min(announced.initialWindowBytes, TUNNEL_INITIAL_WINDOW_BYTES),
    maxDataBytes: Math.min(announced.maxDataBytes, TUNNEL_MAX_DATA_BYTES),
    maxStreams: Math.min(announced.maxStreams, TUNNEL_MAX_STREAMS),
    connectTimeoutMs: Math.min(announced.connectTimeoutMs, TUNNEL_CONNECT_TIMEOUT_MS),
  };
}

function parseIpv4(host: string): Uint8Array | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = new Uint8Array(4);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets[index] = octet;
  }
  return octets;
}

function parseIpv6Part(part: string, isLast: boolean): number[] | null {
  if (part.includes(".")) {
    if (!isLast) return null;
    const ipv4 = parseIpv4(part);
    if (!ipv4) return null;
    return [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]];
  }
  if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
  return [Number.parseInt(part, 16)];
}

function parseIpv6Side(side: string, sideEndsAddress: boolean): number[] | null {
  if (side.length === 0) return [];
  const parts = side.split(":");
  const groups: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const parsed = parseIpv6Part(parts[index], sideEndsAddress && index === parts.length - 1);
    if (!parsed) return null;
    groups.push(...parsed);
  }
  return groups;
}

function parseIpv6(host: string): Uint8Array | null {
  if (!host.includes(":") || host.includes("%")) return null;
  const compressedAt = host.indexOf("::");
  if (compressedAt !== -1 && compressedAt !== host.lastIndexOf("::")) return null;

  const leftText = compressedAt === -1 ? host : host.slice(0, compressedAt);
  const rightText = compressedAt === -1 ? "" : host.slice(compressedAt + 2);
  const left = parseIpv6Side(leftText, compressedAt === -1);
  const right = parseIpv6Side(rightText, true);
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if (compressedAt === -1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  const address = new Uint8Array(16);
  const view = new DataView(address.buffer);
  for (let index = 0; index < groups.length; index += 1) {
    view.setUint16(index * 2, groups[index]);
  }
  return address;
}

function tunnelTarget(host: string, port: number): TunnelTarget {
  const hasOpeningBracket = host.startsWith("[");
  const hasClosingBracket = host.endsWith("]");
  if (hasOpeningBracket !== hasClosingBracket) throw new RangeError("Invalid tunnel host");
  const unwrapped = hasOpeningBracket ? host.slice(1, -1) : host;
  if (unwrapped.length === 0) throw new RangeError("Invalid tunnel host");

  if (hasOpeningBracket) {
    const bracketedIpv6 = parseIpv6(unwrapped);
    if (!bracketedIpv6) throw new RangeError("Invalid tunnel host");
    return { atyp: 4, address: bracketedIpv6, port };
  }

  const ipv4 = parseIpv4(unwrapped);
  if (ipv4) return { atyp: 1, address: ipv4, port };
  const ipv6 = parseIpv6(unwrapped);
  if (ipv6) return { atyp: 4, address: ipv6, port };
  if (unwrapped.includes(":")) throw new RangeError("Invalid tunnel host");
  for (let index = 0; index < unwrapped.length; index += 1) {
    if (unwrapped.charCodeAt(index) > 0x7f) {
      throw new RangeError("Tunnel domain must contain only ASCII characters");
    }
  }
  return { atyp: 3, address: unwrapped, port };
}

function notify(
  callback: () => void,
  failed: (error: unknown, handler: string) => void,
  handler: string,
): void {
  try {
    callback();
  } catch (error) {
    failed(error, handler);
  }
}

function notifyAsync(
  callback: () => void,
  failed: (error: unknown, handler: string) => void,
  handler: string,
): () => void {
  let subscribed = true;
  queueMicrotask(() => {
    if (subscribed) notify(callback, failed, handler);
  });
  return () => {
    subscribed = false;
  };
}

function isTunnelCloseReason(reason: number): reason is TunnelCloseReasonCode {
  return (
    Number.isInteger(reason) &&
    reason >= TunnelCloseReason.Ok &&
    reason <= TunnelCloseReason.ProtocolError
  );
}

class NetworkTunnelStreamImpl implements NetworkTunnelStream {
  private state: StreamState = "connecting";
  private outgoingCredit = 0;
  private incomingCredit: number;

  constructor(
    readonly streamId: string,
    private readonly subscriptionId: string,
    private readonly limits: NetworkTunnelLimits,
    private readonly handlers: NetworkTunnelStreamHandlers,
    private readonly send: (frame: TunnelFrame) => void,
    private readonly finished: (streamId: string) => void,
    private readonly handlerError: (error: unknown, handler: string) => void,
  ) {
    this.incomingCredit = limits.initialWindowBytes;
  }

  write(data: Uint8Array): void {
    if (this.state === "closed") return;
    this.requireConnected("write");
    if (data.length === 0 || data.length > this.limits.maxDataBytes) {
      throw new NetworkTunnelError(
        "max_data_exceeded",
        `Tunnel data must contain 1–${this.limits.maxDataBytes} bytes`,
      );
    }
    if (data.length > this.outgoingCredit) {
      throw new NetworkTunnelError("no_credit", "Tunnel stream has insufficient write credit");
    }
    this.outgoingCredit -= data.length;
    this.send({
      opcode: TunnelOpcode.Data,
      subscriptionId: this.subscriptionId,
      streamId: this.streamId,
      payload: data,
    });
  }

  consume(bytes: number): void {
    if (this.state === "closed") return;
    this.requireConnected("consume");
    const consumed = this.limits.initialWindowBytes - this.incomingCredit;
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > consumed) {
      throw new NetworkTunnelError(
        "invalid_consumption",
        "Tunnel consumption must match bytes received and not yet consumed",
      );
    }
    this.incomingCredit += bytes;
    this.send({
      opcode: TunnelOpcode.WindowUpdate,
      subscriptionId: this.subscriptionId,
      streamId: this.streamId,
      credit: bytes,
    });
  }

  close(reason: number = TunnelCloseReason.Ok): void {
    if (this.state === "closed") return;
    if (!isTunnelCloseReason(reason)) throw new RangeError("Unknown tunnel close reason");
    try {
      this.send({
        opcode: TunnelOpcode.Close,
        subscriptionId: this.subscriptionId,
        streamId: this.streamId,
        reason,
      });
    } finally {
      this.finish(reason);
    }
  }

  connected(): boolean {
    if (this.state !== "connecting") return false;
    this.state = "connected";
    this.outgoingCredit = this.limits.initialWindowBytes;
    notify(this.handlers.onConnected, this.handlerError, "onConnected");
    return true;
  }

  data(payload: Uint8Array): boolean {
    if (this.state !== "connected") return false;
    if (payload.length > this.limits.maxDataBytes || payload.length > this.incomingCredit) {
      return false;
    }
    this.incomingCredit -= payload.length;
    notify(() => this.handlers.onData(payload), this.handlerError, "onData");
    return true;
  }

  credit(credit: number): boolean {
    if (this.state !== "connected") return false;
    if (credit > this.limits.initialWindowBytes - this.outgoingCredit) return false;
    this.outgoingCredit += credit;
    notify(() => this.handlers.onCredit(credit), this.handlerError, "onCredit");
    return true;
  }

  remoteClose(reason: number): void {
    if (this.state === "closed") return;
    this.finish(reason);
  }

  terminate(reason: number): void {
    if (this.state === "closed") return;
    this.finish(reason);
  }

  private requireConnected(operation: string): void {
    if (this.state !== "connected") {
      throw new NetworkTunnelError(
        "invalid_state",
        `Cannot ${operation} before the tunnel stream connects`,
      );
    }
  }

  private finish(reason: number): void {
    this.state = "closed";
    this.finished(this.streamId);
    notify(() => this.handlers.onClose(reason), this.handlerError, "onClose");
  }
}

class NetworkTunnelImpl implements NetworkTunnel {
  readonly limits: NetworkTunnelLimits;
  private active = true;
  private closedReason: NetworkTunnelClosedReason | null = null;
  private readonly streams = new Map<string, NetworkTunnelStreamImpl>();
  private readonly closedStreamIds = new RecentIds();
  private readonly closedListeners = new Set<(reason: NetworkTunnelClosedReason) => void>();

  constructor(
    readonly subscriptionId: string,
    announcedLimits: AnnouncedNetworkTunnelLimits,
    private readonly connection: NetworkTunnelConnection,
    private readonly finished: (subscriptionId: string) => void,
  ) {
    this.limits = applyClientLimits(announcedLimits);
  }

  openStream(
    target: NetworkTunnelTarget,
    handlers: NetworkTunnelStreamHandlers,
  ): NetworkTunnelStream {
    if (!this.active) throw new NetworkTunnelError("closed", "Network tunnel is closed");
    if (this.streams.size >= this.limits.maxStreams) {
      throw new NetworkTunnelError("stream_limit", "Network tunnel stream limit reached");
    }
    const streamId = target.streamId ?? this.connection.createStreamId();
    if (this.streams.has(streamId) || this.closedStreamIds.has(streamId)) {
      throw new NetworkTunnelError(
        "duplicate_stream",
        `Tunnel stream ID is already used: ${streamId}`,
      );
    }
    const destination = tunnelTarget(target.host, target.port);
    const openFrame = encodeTunnelFrame({
      opcode: TunnelOpcode.Open,
      subscriptionId: this.subscriptionId,
      streamId,
      target: destination,
    });
    const stream = new NetworkTunnelStreamImpl(
      streamId,
      this.subscriptionId,
      this.limits,
      handlers,
      (frame) => this.send(frame),
      (closedStreamId) => {
        this.streams.delete(closedStreamId);
        this.closedStreamIds.add(closedStreamId);
      },
      this.connection.handlerError,
    );
    this.streams.set(streamId, stream);
    try {
      this.connection.send(openFrame);
    } catch (error) {
      this.streams.delete(streamId);
      throw error;
    }
    return stream;
  }

  async close(): Promise<void> {
    if (!this.active) return;
    this.finish("closed", TunnelCloseReason.Ok);
    await this.connection.close(this.subscriptionId);
  }

  onClosed(listener: (reason: NetworkTunnelClosedReason) => void): () => void {
    const closedReason = this.closedReason;
    if (closedReason) {
      return notifyAsync(() => listener(closedReason), this.connection.handlerError, "onClosed");
    }
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  receive(frame: TunnelFrame): void {
    if (!this.active) return;
    if (frame.opcode === TunnelOpcode.Open) {
      this.protocolViolation(frame.streamId);
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      if (!this.closedStreamIds.has(frame.streamId)) this.protocolViolation(frame.streamId);
      return;
    }

    let valid = true;
    switch (frame.opcode) {
      case TunnelOpcode.Connected:
        valid = stream.connected();
        break;
      case TunnelOpcode.Data:
        valid = stream.data(frame.payload);
        break;
      case TunnelOpcode.WindowUpdate:
        valid = stream.credit(frame.credit);
        break;
      case TunnelOpcode.Close:
        stream.remoteClose(frame.reason);
        break;
    }
    if (!valid) this.protocolViolation(frame.streamId);
  }

  disconnected(): void {
    this.finish("disconnected", TunnelCloseReason.GeneralError);
  }

  daemonClosed(reason: DaemonNetworkTunnelClosedReason): void {
    const mapped = {
      revoked: { tunnel: "closed", stream: TunnelCloseReason.PolicyDenied },
      protocol_error: { tunnel: "protocol_error", stream: TunnelCloseReason.ProtocolError },
      resource_limit: { tunnel: "closed", stream: TunnelCloseReason.StreamLimit },
      internal_error: { tunnel: "closed", stream: TunnelCloseReason.GeneralError },
    } as const;
    const closure = mapped[reason];
    this.finish(closure.tunnel, closure.stream);
  }

  protocolViolation(streamId?: string): void {
    if (!this.active) return;
    let closeFrame: Uint8Array | null = null;
    if (streamId && this.streams.has(streamId)) {
      closeFrame = encodeTunnelFrame({
        opcode: TunnelOpcode.Close,
        subscriptionId: this.subscriptionId,
        streamId,
        reason: TunnelCloseReason.ProtocolError,
      });
    }
    this.finish("protocol_error", TunnelCloseReason.ProtocolError);
    try {
      if (closeFrame) this.connection.send(closeFrame);
    } finally {
      this.connection.closeProtocolViolation(this.subscriptionId);
    }
  }

  private send(frame: TunnelFrame): void {
    if (!this.active) throw new NetworkTunnelError("closed", "Network tunnel is closed");
    this.connection.send(encodeTunnelFrame(frame));
  }

  private finish(reason: NetworkTunnelClosedReason, streamReason: number): void {
    if (!this.active) return;
    this.active = false;
    this.closedReason = reason;
    for (const stream of this.streams.values()) stream.terminate(streamReason);
    this.streams.clear();
    this.finished(this.subscriptionId);
    for (const listener of this.closedListeners) {
      notify(() => listener(reason), this.connection.handlerError, "onClosed");
    }
    this.closedListeners.clear();
  }
}

export class NetworkTunnelRegistry {
  private readonly tunnels = new Map<string, NetworkTunnelImpl>();
  private readonly closedSubscriptionIds = new RecentIds();

  constructor(private readonly connection: NetworkTunnelConnection) {}

  open(subscriptionId: string, limits: AnnouncedNetworkTunnelLimits): NetworkTunnel {
    const tunnel = new NetworkTunnelImpl(subscriptionId, limits, this.connection, (closedId) => {
      this.tunnels.delete(closedId);
      this.closedSubscriptionIds.add(closedId);
    });
    this.tunnels.set(subscriptionId, tunnel);
    return tunnel;
  }

  receive(frame: TunnelFrame): "handled" | "unknown_subscription" {
    const tunnel = this.tunnels.get(frame.subscriptionId);
    if (tunnel) {
      tunnel.receive(frame);
      return "handled";
    }
    return this.closedSubscriptionIds.has(frame.subscriptionId)
      ? "handled"
      : "unknown_subscription";
  }

  disconnected(): void {
    for (const tunnel of this.tunnels.values()) tunnel.disconnected();
    this.tunnels.clear();
    this.closedSubscriptionIds.clear();
  }

  daemonClosed(subscriptionId: string, reason: DaemonNetworkTunnelClosedReason): void {
    this.tunnels.get(subscriptionId)?.daemonClosed(reason);
  }
}
