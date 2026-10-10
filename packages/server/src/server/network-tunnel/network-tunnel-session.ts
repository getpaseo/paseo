import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import type pino from "pino";
import {
  TunnelCloseReason,
  TunnelOpcode,
  encodeTunnelFrame,
  type TunnelFrame,
  type TunnelTarget,
} from "@getpaseo/protocol/binary-frames/index";
import {
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_STREAMS,
  type NetworkTunnelClosedReason,
  type NetworkTunnelLimits,
  type NetworkTunnelRpcError,
} from "@getpaseo/protocol/network-tunnel/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { OwnedSubscription } from "../session/owned-subscriptions/index.js";
import {
  TunnelTargetError,
  approveAddresses,
  closeReasonForError,
  describeTunnelTarget,
  normalizeAddress,
  type ResolvedTunnelAddress,
} from "./target-policy.js";

type TunnelOpenRequest = Extract<SessionInboundMessage, { type: "network.tunnel.open.request" }>;
type TunnelCloseRequest = Extract<SessionInboundMessage, { type: "network.tunnel.close.request" }>;
type CloseReason = (typeof TunnelCloseReason)[keyof typeof TunnelCloseReason];

export const NETWORK_TUNNEL_FAMILY = "network.tunnel";
/** Each subscription may hold maxStreams × 2 windows of buffers; cap how many one session can open. */
export const MAX_TUNNEL_SUBSCRIPTIONS_PER_SESSION = 4;
/** After a client-initiated graceful close, how long the remote may take to acknowledge our FIN. */
const GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
/** Frames still in flight for a subscription this connection recently lost are dropped, not punished. */
const RECENTLY_CLOSED_PER_SOURCE = 32;

export interface NetworkTunnelHost {
  emit(message: SessionOutboundMessage): void;
  /** Wraps `delivery.begin(NETWORK_TUNNEL_FAMILY, undefined, stop)` for the current request. */
  begin(stop: (id: string) => void | Promise<void>): OwnedSubscription;
  currentSource(): object | undefined;
  /** The owned-subscriptions capability; tunnels never run on the legacy broadcast path. */
  isModernSource(source: object): boolean;
  supportsTunnel(source: object): boolean;
  allowsNetworkProxy(): boolean;
}

export type TunnelLookup = (hostname: string) => Promise<ResolvedTunnelAddress[]>;

export interface NetworkTunnelSessionOptions {
  host: NetworkTunnelHost;
  logger: pino.Logger;
  limits?: Partial<NetworkTunnelLimits>;
  maxSubscriptions?: number;
  lookup?: TunnelLookup;
}

/** Thrown for frames whose owner cannot be established; the socket's existing error path reports it. */
export class TunnelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelProtocolError";
  }
}

interface TunnelSubscription {
  owner: OwnedSubscription;
  streams: Map<string, TunnelStream>;
  /** Sockets draining a client-initiated graceful close; released with the subscription. */
  closing: Set<net.Socket>;
  released: boolean;
}

type StreamState = "connecting" | "connected" | "closed";

interface TunnelStream {
  id: string;
  subscription: TunnelSubscription;
  state: StreamState;
  socket: net.Socket | null;
  cancel: AbortController;
  /** Bytes the client may still send before we return a WindowUpdate. */
  inboundCredit: number;
  /** Bytes the TCP socket has consumed that we have not yet credited back. */
  pendingInboundCredit: number;
  creditFlushScheduled: boolean;
  /** Bytes we may still send before the client returns a WindowUpdate. */
  outboundCredit: number;
  pendingOut: Buffer[];
  pendingOutBytes: number;
  paused: boolean;
  remoteEnded: boolean;
}

async function defaultLookup(hostname: string): Promise<ResolvedTunnelAddress[]> {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((entry) => normalizeAddress(entry.address));
}

/**
 * Owns every network tunnel of one session. A tunnel is an owned subscription;
 * its streams are TCP sockets dialed from the daemon host. Both directions are
 * credit-gated so a slow relay or a slow destination never grows an unbounded
 * queue: outbound Data waits for the client's WindowUpdate and pauses the socket,
 * inbound Data is credited back only after the socket's write callback fires.
 */
export class NetworkTunnelSession {
  private readonly host: NetworkTunnelHost;
  private readonly logger: pino.Logger;
  private readonly limits: NetworkTunnelLimits;
  private readonly maxSubscriptions: number;
  private readonly lookup: TunnelLookup;
  private readonly subscriptions = new Map<string, TunnelSubscription>();
  private readonly recentlyClosed = new WeakMap<object, string[]>();

  constructor(options: NetworkTunnelSessionOptions) {
    this.host = options.host;
    this.logger = options.logger.child({ module: "network-tunnel" });
    this.limits = {
      initialWindowBytes: options.limits?.initialWindowBytes ?? TUNNEL_INITIAL_WINDOW_BYTES,
      maxDataBytes: options.limits?.maxDataBytes ?? TUNNEL_MAX_DATA_BYTES,
      maxStreams: options.limits?.maxStreams ?? TUNNEL_MAX_STREAMS,
      connectTimeoutMs: options.limits?.connectTimeoutMs ?? TUNNEL_CONNECT_TIMEOUT_MS,
    };
    this.maxSubscriptions = options.maxSubscriptions ?? MAX_TUNNEL_SUBSCRIPTIONS_PER_SESSION;
    this.lookup = options.lookup ?? defaultLookup;
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  streamCount(subscriptionId: string): number {
    return this.subscriptions.get(subscriptionId)?.streams.size ?? 0;
  }

  closingSocketCount(subscriptionId: string): number {
    return this.subscriptions.get(subscriptionId)?.closing.size ?? 0;
  }

  handleOpenRequest(request: TunnelOpenRequest): void {
    const { requestId } = request;
    if (!this.host.allowsNetworkProxy()) {
      this.failOpen(requestId, "permission_denied", "Session lacks the network.proxy permission");
      return;
    }
    const source = this.host.currentSource();
    if (!source || !this.host.isModernSource(source) || !this.host.supportsTunnel(source)) {
      this.failOpen(
        requestId,
        "unsupported_capability",
        "Network tunnels require the owned_subscriptions and network_tunnel capabilities",
      );
      return;
    }
    if (this.subscriptions.size >= this.maxSubscriptions) {
      this.failOpen(requestId, "resource_limit", "Too many network tunnels for this session");
      return;
    }
    const owner = this.host.begin((id) => this.stop(id));
    this.subscriptions.set(owner.id, {
      owner,
      streams: new Map(),
      closing: new Set(),
      released: false,
    });
    this.host.emit({
      type: "network.tunnel.open.response",
      payload: { requestId, ok: true, subscriptionId: owner.responseId, ...this.limits },
    });
  }

  async handleCloseRequest(request: TunnelCloseRequest): Promise<void> {
    const { requestId, subscriptionId } = request;
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || subscription.owner.source !== this.host.currentSource()) {
      this.host.emit({
        type: "network.tunnel.close.response",
        payload: {
          requestId,
          ok: false,
          error: { code: "not_found", message: "Unknown network tunnel" },
        },
      });
      return;
    }
    await subscription.owner.release();
    this.host.emit({
      type: "network.tunnel.close.response",
      payload: { requestId, ok: true, subscriptionId },
    });
  }

  /** Runs before the terminal/files permission gate; the tunnel carries its own authority. */
  async handleFrame(frame: TunnelFrame, source: object): Promise<void> {
    if (!this.host.allowsNetworkProxy()) {
      await this.releaseAll();
      return;
    }
    const subscription = this.subscriptions.get(frame.subscriptionId);
    if (!subscription || subscription.owner.source !== source) {
      if (!subscription && this.recentlyClosed.get(source)?.includes(frame.subscriptionId)) return;
      throw new TunnelProtocolError("Tunnel frame does not belong to an owned subscription");
    }
    switch (frame.opcode) {
      case TunnelOpcode.Open:
        this.openStream(subscription, frame.streamId, frame.target);
        return;
      case TunnelOpcode.Data:
        await this.receiveData(subscription, frame.streamId, frame.payload);
        return;
      case TunnelOpcode.WindowUpdate:
        await this.receiveCredit(subscription, frame.streamId, frame.credit);
        return;
      case TunnelOpcode.Close:
        this.receiveClose(subscription, frame.streamId, frame.reason);
        return;
      case TunnelOpcode.Connected:
        await this.violate(subscription, frame.streamId, "client sent Connected");
        return;
    }
  }

  async releaseAll(): Promise<void> {
    await Promise.all(
      [...this.subscriptions.values()].map((subscription) => subscription.owner.release()),
    );
  }

  /**
   * Call before the session drops network.proxy: the notice itself needs that
   * permission to leave, and it is emitted synchronously before the first await.
   */
  revoke(): Promise<void> {
    for (const subscription of this.subscriptions.values()) {
      this.announceClosed(subscription, "revoked");
    }
    return this.releaseAll();
  }

  private failOpen(requestId: string, code: NetworkTunnelRpcError["code"], message: string): void {
    this.host.emit({
      type: "network.tunnel.open.response",
      payload: { requestId, ok: false, error: { code, message } },
    });
  }

  private stop(id: string): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    subscription.released = true;
    for (const stream of subscription.streams.values()) this.teardownStream(stream);
    subscription.streams.clear();
    for (const socket of subscription.closing) destroySocket(socket);
    subscription.closing.clear();
    const closed = this.recentlyClosed.get(subscription.owner.source) ?? [];
    closed.push(id);
    if (closed.length > RECENTLY_CLOSED_PER_SOURCE) closed.shift();
    this.recentlyClosed.set(subscription.owner.source, closed);
  }

  /** JSON notice for daemon-initiated teardown; after release the owner can no longer send binary frames. */
  private announceClosed(subscription: TunnelSubscription, reason: NetworkTunnelClosedReason) {
    if (subscription.released) return;
    subscription.owner.emit({
      type: "network.tunnel.closed",
      payload: { subscriptionId: subscription.owner.id, reason },
    });
  }

  private openStream(subscription: TunnelSubscription, streamId: string, target: TunnelTarget) {
    if (subscription.streams.has(streamId)) {
      void this.violate(subscription, streamId, "duplicate stream open");
      return;
    }
    if (subscription.streams.size >= this.limits.maxStreams) {
      this.sendClose(subscription, streamId, TunnelCloseReason.StreamLimit);
      return;
    }
    const stream: TunnelStream = {
      id: streamId,
      subscription,
      state: "connecting",
      socket: null,
      cancel: new AbortController(),
      inboundCredit: 0,
      pendingInboundCredit: 0,
      creditFlushScheduled: false,
      outboundCredit: 0,
      pendingOut: [],
      pendingOutBytes: 0,
      paused: false,
      remoteEnded: false,
    };
    subscription.streams.set(streamId, stream);
    void this.connectStream(stream, target);
  }

  private async connectStream(stream: TunnelStream, target: TunnelTarget): Promise<void> {
    const deadline = Date.now() + this.limits.connectTimeoutMs;
    const described = describeTunnelTarget(target);
    const hostLabel = described.kind === "literal" ? described.address.address : described.hostname;
    try {
      const candidates =
        described.kind === "literal"
          ? [described.address]
          : await withDeadline(this.lookup(described.hostname), deadline, stream.cancel.signal);
      const approved = approveAddresses(candidates);
      if (stream.state !== "connecting") return;
      const socket = await dialAny(approved, target.port, deadline, stream.cancel.signal);
      if (stream.state !== "connecting") {
        socket.destroy();
        return;
      }
      this.attachSocket(stream, socket);
      this.logger.debug(
        { streamId: stream.id, host: hostLabel, port: target.port },
        "Tunnel stream connected",
      );
    } catch (error) {
      if (stream.state !== "connecting") return;
      const reason = closeReasonForError(error);
      this.logger.debug(
        { streamId: stream.id, host: hostLabel, port: target.port, reason },
        "Tunnel stream connect failed",
      );
      this.finishStream(stream, reason);
    }
  }

  private attachSocket(stream: TunnelStream, socket: net.Socket): void {
    stream.socket = socket;
    stream.state = "connected";
    stream.inboundCredit = this.limits.initialWindowBytes;
    stream.outboundCredit = this.limits.initialWindowBytes;
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      if (stream.state !== "connected") return;
      stream.pendingOut.push(chunk);
      stream.pendingOutBytes += chunk.length;
      this.flushOutbound(stream);
    });
    socket.on("end", () => this.remoteEnded(stream));
    socket.on("close", () => this.remoteEnded(stream));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (stream.state !== "connected") return;
      this.logger.debug({ streamId: stream.id, code: error.code }, "Tunnel stream socket error");
      this.finishStream(stream, TunnelCloseReason.GeneralError);
    });
    this.send(stream.subscription, {
      opcode: TunnelOpcode.Connected,
      subscriptionId: stream.subscription.owner.id,
      streamId: stream.id,
    });
  }

  private flushOutbound(stream: TunnelStream): void {
    const socket = stream.socket;
    if (!socket) return;
    while (stream.pendingOutBytes > 0 && stream.outboundCredit > 0) {
      const head = stream.pendingOut[0];
      const size = Math.min(head.length, this.limits.maxDataBytes, stream.outboundCredit);
      if (size === head.length) stream.pendingOut.shift();
      else stream.pendingOut[0] = head.subarray(size);
      stream.pendingOutBytes -= size;
      stream.outboundCredit -= size;
      this.send(stream.subscription, {
        opcode: TunnelOpcode.Data,
        subscriptionId: stream.subscription.owner.id,
        streamId: stream.id,
        payload: head.subarray(0, size),
      });
    }
    if (stream.pendingOutBytes > 0) {
      if (!stream.paused) {
        stream.paused = true;
        socket.pause();
      }
      return;
    }
    if (stream.remoteEnded) {
      this.finishStream(stream, TunnelCloseReason.Ok);
      return;
    }
    if (stream.paused) {
      stream.paused = false;
      socket.resume();
    }
  }

  private remoteEnded(stream: TunnelStream): void {
    if (stream.state !== "connected") return;
    stream.remoteEnded = true;
    // Bytes already read stay queued until the client credits them; Close follows the last Data.
    if (stream.pendingOutBytes === 0) this.finishStream(stream, TunnelCloseReason.Ok);
  }

  private async receiveData(
    subscription: TunnelSubscription,
    streamId: string,
    payload: Uint8Array,
  ): Promise<void> {
    const stream = subscription.streams.get(streamId);
    if (!stream) return;
    if (stream.state !== "connected" || !stream.socket) {
      await this.violate(subscription, streamId, "Data before Connected");
      return;
    }
    if (payload.length > this.limits.maxDataBytes || payload.length > stream.inboundCredit) {
      await this.violate(subscription, streamId, "Data exceeds credit");
      return;
    }
    stream.inboundCredit -= payload.length;
    const consumed = payload.length;
    stream.socket.write(payload, (error) => {
      if (error || stream.state !== "connected") return;
      stream.pendingInboundCredit += consumed;
      this.scheduleCreditFlush(stream);
    });
  }

  private scheduleCreditFlush(stream: TunnelStream): void {
    if (stream.creditFlushScheduled) return;
    stream.creditFlushScheduled = true;
    setImmediate(() => {
      stream.creditFlushScheduled = false;
      if (stream.state !== "connected" || stream.pendingInboundCredit === 0) return;
      const credit = stream.pendingInboundCredit;
      stream.pendingInboundCredit = 0;
      stream.inboundCredit += credit;
      this.send(stream.subscription, {
        opcode: TunnelOpcode.WindowUpdate,
        subscriptionId: stream.subscription.owner.id,
        streamId: stream.id,
        credit,
      });
    });
  }

  private async receiveCredit(
    subscription: TunnelSubscription,
    streamId: string,
    credit: number,
  ): Promise<void> {
    const stream = subscription.streams.get(streamId);
    if (!stream) return;
    if (stream.state !== "connected") {
      await this.violate(subscription, streamId, "WindowUpdate before Connected");
      return;
    }
    const inFlight = this.limits.initialWindowBytes - stream.outboundCredit;
    if (credit > inFlight) {
      await this.violate(subscription, streamId, "WindowUpdate exceeds delivered bytes");
      return;
    }
    stream.outboundCredit += credit;
    this.flushOutbound(stream);
  }

  private receiveClose(subscription: TunnelSubscription, streamId: string, reason: CloseReason) {
    const stream = subscription.streams.get(streamId);
    if (!stream) return;
    const socket = stream.socket;
    if (reason === TunnelCloseReason.Ok && stream.state === "connected" && socket) {
      // Queued request bytes still reach the destination; the FIN follows them. The socket stays
      // owned by the subscription until it really closes, so release can still destroy it.
      stream.state = "closed";
      stream.socket = null;
      subscription.streams.delete(streamId);
      detachSocket(socket);
      subscription.closing.add(socket);
      socket.once("close", () => subscription.closing.delete(socket));
      socket.setTimeout(GRACEFUL_CLOSE_TIMEOUT_MS, () => socket.destroy());
      socket.end();
      return;
    }
    this.teardownStream(stream);
  }

  private async violate(
    subscription: TunnelSubscription,
    streamId: string,
    detail: string,
  ): Promise<void> {
    this.logger.warn(
      { subscriptionId: subscription.owner.id, streamId, detail },
      "Tunnel protocol violation; releasing subscription",
    );
    this.sendClose(subscription, streamId, TunnelCloseReason.ProtocolError);
    this.announceClosed(subscription, "protocol_error");
    await subscription.owner.release();
  }

  /** Ends a stream from the daemon side and tells the client why. */
  private finishStream(stream: TunnelStream, reason: CloseReason): void {
    if (stream.state === "closed") return;
    const { subscription } = stream;
    this.teardownStream(stream);
    this.sendClose(subscription, stream.id, reason);
  }

  private teardownStream(stream: TunnelStream): void {
    stream.state = "closed";
    stream.subscription.streams.delete(stream.id);
    stream.cancel.abort();
    stream.pendingOut = [];
    stream.pendingOutBytes = 0;
    const socket = stream.socket;
    stream.socket = null;
    if (socket) destroySocket(socket);
  }

  private sendClose(subscription: TunnelSubscription, streamId: string, reason: CloseReason) {
    this.send(subscription, {
      opcode: TunnelOpcode.Close,
      subscriptionId: subscription.owner.id,
      streamId,
      reason,
    });
  }

  private send(subscription: TunnelSubscription, frame: TunnelFrame): void {
    if (subscription.released) return;
    subscription.owner.emitBinary(encodeTunnelFrame(frame));
  }
}

function detachSocket(socket: net.Socket): void {
  socket.removeAllListeners("data");
  socket.removeAllListeners("end");
  socket.removeAllListeners("close");
  socket.removeAllListeners("error");
  socket.on("error", () => {});
}

function destroySocket(socket: net.Socket): void {
  detachSocket(socket);
  socket.setTimeout(0);
  socket.destroy();
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TunnelTargetError(TunnelCloseReason.Timeout, "Timed out resolving host")),
      Math.max(0, deadline - Date.now()),
    );
    onAbort = () => reject(new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** `localhost` often resolves to ::1 first while the service listens on 127.0.0.1; try every approved answer. */
async function dialAny(
  addresses: readonly ResolvedTunnelAddress[],
  port: number,
  deadline: number,
  signal: AbortSignal,
): Promise<net.Socket> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await dial(address, port, deadline, signal);
    } catch (error) {
      lastError = error;
      const reason = closeReasonForError(error);
      if (reason === TunnelCloseReason.Timeout || reason === TunnelCloseReason.Ok) break;
    }
  }
  throw lastError;
}

/** Dials the approved literal only; no second resolution can swap the target underneath the policy check. */
function dial(
  address: ResolvedTunnelAddress,
  port: number,
  deadline: number,
  signal: AbortSignal,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const socket = net.connect({ host: address.address, port, family: address.family });
    const settle = (outcome: { socket: net.Socket } | { error: unknown }) => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      signal.removeEventListener("abort", onAbort);
      if ("socket" in outcome) {
        resolve(outcome.socket);
        return;
      }
      socket.destroy();
      reject(outcome.error);
    };
    const onConnect = () => settle({ socket });
    const onError = (error: Error) => settle({ error });
    const onTimeout = () =>
      settle({ error: new TunnelTargetError(TunnelCloseReason.Timeout, "Connect timed out") });
    const onAbort = () =>
      settle({ error: new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled") });
    socket.setTimeout(remaining);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
