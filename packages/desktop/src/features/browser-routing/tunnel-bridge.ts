import { randomUUID } from "node:crypto";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/tunnel";
import {
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_STREAMS,
} from "@getpaseo/protocol/network-tunnel/rpc-schemas";
import type { ProxyTarget, TunnelStreamHandle, TunnelStreamSink } from "./local-proxy.js";
import { TunnelStreamError } from "./local-proxy.js";

// Extra time main waits for Connected beyond the daemon's own connect timeout, so a
// renderer that stops relaying never leaves a CONNECT hanging without an answer.
const CONNECT_GRACE_MS = 5_000;

export const TUNNEL_PROVIDER_CLOSED_REASONS = [
  "unregistered",
  "disabled",
  "disconnected",
  "protocol_error",
] as const;
export type TunnelProviderClosedReason = (typeof TUNNEL_PROVIDER_CLOSED_REASONS)[number];

export type TunnelInvokeErrorCode =
  | "invalid_payload"
  | "provider_exists"
  | "provider_unavailable"
  | "not_owner"
  | "unknown_stream"
  | "protocol_error";

export type TunnelInvokeResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: { code: TunnelInvokeErrorCode; message: string } };

export interface TunnelProviderLimits {
  initialWindowBytes: number;
  maxDataBytes: number;
  maxStreams: number;
  connectTimeoutMs: number;
}

export interface TunnelProviderRegistration extends TunnelProviderLimits {
  serverId: string;
  subscriptionId: string;
}

export interface TunnelStreamRef {
  serverId: string;
  providerId: string;
  streamId: string;
}

export type TunnelBridgeEvent =
  | { name: "network_tunnel_stream_open"; payload: TunnelStreamRef & ProxyTarget }
  | { name: "network_tunnel_stream_data"; payload: TunnelStreamRef & { data: Uint8Array } }
  | { name: "network_tunnel_stream_credit"; payload: TunnelStreamRef & { credit: number } }
  | { name: "network_tunnel_stream_close"; payload: TunnelStreamRef & { reason: number } }
  | {
      name: "network_tunnel_provider_closed";
      payload: { serverId: string; providerId: string; reason: TunnelProviderClosedReason };
    };

export interface TunnelBridgeDependencies {
  /** Delivers an event to one renderer. Returns false when that renderer is gone. */
  emit(senderId: number, event: TunnelBridgeEvent): boolean;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  generateId?: () => string;
  log?: (event: string, details: Record<string, unknown>) => void;
}

interface PendingWrite {
  data: Uint8Array;
  offset: number;
  callback: (error?: Error | null) => void;
}

interface StreamState {
  readonly streamId: string;
  readonly provider: ProviderState;
  readonly sink: TunnelStreamSink;
  phase: "connecting" | "open" | "closed";
  sendCredit: number;
  readonly pendingWrites: PendingWrite[];
  receiveOutstanding: number;
  pendingCredit: number;
  creditFlushScheduled: boolean;
  connectTimer: unknown;
}

interface ProviderState {
  readonly serverId: string;
  readonly providerId: string;
  readonly subscriptionId: string;
  readonly senderId: number;
  readonly limits: TunnelProviderLimits;
  readonly streams: Map<string, StreamState>;
}

function failure(code: TunnelInvokeErrorCode, message: string): TunnelInvokeResult<never> {
  return { ok: false, error: { code, message } };
}

function providerClosedStreamReason(reason: TunnelProviderClosedReason): number {
  return reason === "protocol_error"
    ? TunnelCloseReason.ProtocolError
    : TunnelCloseReason.NetworkUnreachable;
}

/**
 * One tunnel provider per daemon serverId, bound to the renderer webContents that
 * registered it. Main owns stream ids and both credit windows: outbound credit is
 * debited when Data is emitted to the renderer, inbound credit is returned only after
 * the proxy reports the bytes consumed.
 */
export class TunnelBridge {
  private readonly providersByServerId = new Map<string, ProviderState>();
  private readonly emit: TunnelBridgeDependencies["emit"];
  private readonly scheduleTimeout: NonNullable<TunnelBridgeDependencies["setTimeout"]>;
  private readonly cancelTimeout: NonNullable<TunnelBridgeDependencies["clearTimeout"]>;
  private readonly generateId: () => string;
  private readonly log: NonNullable<TunnelBridgeDependencies["log"]>;

  public constructor(deps: TunnelBridgeDependencies) {
    this.emit = deps.emit;
    this.scheduleTimeout =
      deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = deps.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.generateId = deps.generateId ?? randomUUID;
    this.log = deps.log ?? (() => {});
  }

  public hasProvider(serverId: string): boolean {
    return this.providersByServerId.has(serverId);
  }

  public register(
    senderId: number,
    registration: TunnelProviderRegistration,
  ): TunnelInvokeResult<{ providerId: string }> {
    if (this.providersByServerId.has(registration.serverId)) {
      return failure("provider_exists", "Another window already provides this host's tunnel.");
    }
    const provider: ProviderState = {
      serverId: registration.serverId,
      providerId: this.generateId(),
      subscriptionId: registration.subscriptionId,
      senderId,
      limits: {
        initialWindowBytes: Math.min(registration.initialWindowBytes, TUNNEL_INITIAL_WINDOW_BYTES),
        maxDataBytes: Math.min(registration.maxDataBytes, TUNNEL_MAX_DATA_BYTES),
        maxStreams: Math.min(registration.maxStreams, TUNNEL_MAX_STREAMS),
        connectTimeoutMs: Math.min(registration.connectTimeoutMs, TUNNEL_CONNECT_TIMEOUT_MS),
      },
      streams: new Map(),
    };
    this.providersByServerId.set(provider.serverId, provider);
    this.log("provider.registered", {
      serverId: provider.serverId,
      providerId: provider.providerId,
      senderId,
    });
    return { ok: true, providerId: provider.providerId };
  }

  public unregister(
    senderId: number,
    ref: { serverId: string; providerId: string },
  ): TunnelInvokeResult {
    const provider = this.resolveProvider(senderId, ref);
    if (!provider.ok) return provider;
    this.closeProvider(provider.value.serverId, "unregistered", { notifyRenderer: false });
    return { ok: true };
  }

  public streamConnected(senderId: number, ref: TunnelStreamRef): TunnelInvokeResult {
    const stream = this.resolveStream(senderId, ref);
    if (!stream.ok) return stream;
    const state = stream.value;
    if (state.phase !== "connecting") {
      this.closeStreamFromMain(state, TunnelCloseReason.ProtocolError, { notifySink: true });
      return failure("protocol_error", "Stream was already connected.");
    }
    state.phase = "open";
    this.cancelTimeout(state.connectTimer);
    state.connectTimer = null;
    state.sink.onConnected();
    this.drainWrites(state);
    return { ok: true };
  }

  public streamData(senderId: number, ref: TunnelStreamRef, data: Uint8Array): TunnelInvokeResult {
    const stream = this.resolveStream(senderId, ref);
    if (!stream.ok) return stream;
    const state = stream.value;
    const limits = state.provider.limits;
    if (state.phase !== "open") {
      this.closeStreamFromMain(state, TunnelCloseReason.ProtocolError, { notifySink: true });
      return failure("protocol_error", "Data arrived before the stream connected.");
    }
    if (data.byteLength === 0 || data.byteLength > limits.maxDataBytes) {
      this.closeProvider(state.provider.serverId, "protocol_error");
      return failure("protocol_error", "Data frame size is outside the negotiated limits.");
    }
    if (state.receiveOutstanding + data.byteLength > limits.initialWindowBytes) {
      this.closeProvider(state.provider.serverId, "protocol_error");
      return failure("protocol_error", "Data exceeded the receive window.");
    }
    state.receiveOutstanding += data.byteLength;
    let consumed = false;
    state.sink.onData(data, () => {
      if (consumed || state.phase === "closed") return;
      consumed = true;
      state.receiveOutstanding -= data.byteLength;
      state.pendingCredit += data.byteLength;
      this.scheduleCreditFlush(state);
    });
    return { ok: true };
  }

  public streamCredit(senderId: number, ref: TunnelStreamRef, credit: number): TunnelInvokeResult {
    const stream = this.resolveStream(senderId, ref);
    if (!stream.ok) return stream;
    const state = stream.value;
    if (state.phase !== "open") {
      this.closeStreamFromMain(state, TunnelCloseReason.ProtocolError, { notifySink: true });
      return failure("protocol_error", "Credit arrived before the stream connected.");
    }
    if (state.sendCredit + credit > state.provider.limits.initialWindowBytes) {
      this.closeProvider(state.provider.serverId, "protocol_error");
      return failure("protocol_error", "Credit exceeded the send window.");
    }
    state.sendCredit += credit;
    this.drainWrites(state);
    return { ok: true };
  }

  public streamClose(senderId: number, ref: TunnelStreamRef, reason: number): TunnelInvokeResult {
    const stream = this.resolveStream(senderId, ref);
    if (!stream.ok) return stream;
    const state = stream.value;
    this.detachStream(state, new TunnelStreamError(reason));
    state.sink.onClose(reason);
    return { ok: true };
  }

  public openStreamFor(
    serverId: string,
    target: ProxyTarget,
    sink: TunnelStreamSink,
  ): TunnelStreamHandle | null {
    const provider = this.providersByServerId.get(serverId);
    if (!provider) {
      return null;
    }
    if (provider.streams.size >= provider.limits.maxStreams) {
      queueMicrotask(() => sink.onClose(TunnelCloseReason.StreamLimit));
      return {
        write: (_data, callback) => callback(new TunnelStreamError(TunnelCloseReason.StreamLimit)),
        close: () => {},
      };
    }
    const state: StreamState = {
      streamId: this.generateId(),
      provider,
      sink,
      phase: "connecting",
      sendCredit: provider.limits.initialWindowBytes,
      pendingWrites: [],
      receiveOutstanding: 0,
      pendingCredit: 0,
      creditFlushScheduled: false,
      connectTimer: null,
    };
    provider.streams.set(state.streamId, state);
    const delivered = this.send(provider, {
      name: "network_tunnel_stream_open",
      payload: { ...this.ref(state), host: target.host, port: target.port },
    });
    if (!delivered) {
      return null;
    }
    state.connectTimer = this.scheduleTimeout(() => {
      if (state.phase === "connecting") {
        this.closeStreamFromMain(state, TunnelCloseReason.Timeout, { notifySink: true });
      }
    }, provider.limits.connectTimeoutMs + CONNECT_GRACE_MS);

    return {
      write: (data, callback) => {
        if (state.phase === "closed") {
          callback(new TunnelStreamError(TunnelCloseReason.GeneralError));
          return;
        }
        if (data.byteLength === 0) {
          callback();
          return;
        }
        state.pendingWrites.push({ data, offset: 0, callback });
        this.drainWrites(state);
      },
      close: (reason = TunnelCloseReason.Ok) => {
        if (state.phase !== "closed") {
          this.closeStreamFromMain(state, reason);
        }
      },
    };
  }

  public closeProvider(
    serverId: string,
    reason: TunnelProviderClosedReason,
    options: { notifyRenderer?: boolean } = {},
  ): void {
    const provider = this.providersByServerId.get(serverId);
    if (!provider) return;
    this.providersByServerId.delete(serverId);
    const streamReason = providerClosedStreamReason(reason);
    // Map iteration tolerates the deletions detachStream performs.
    for (const state of provider.streams.values()) {
      this.detachStream(state, new TunnelStreamError(streamReason));
      state.sink.onClose(streamReason);
    }
    if (options.notifyRenderer !== false) {
      this.emit(provider.senderId, {
        name: "network_tunnel_provider_closed",
        payload: { serverId, providerId: provider.providerId, reason },
      });
    }
    this.log("provider.closed", { serverId, providerId: provider.providerId, reason });
  }

  public closeProvidersForSender(
    senderId: number,
    reason: TunnelProviderClosedReason,
    options: { notifyRenderer?: boolean } = {},
  ): string[] {
    const closedServerIds: string[] = [];
    for (const provider of this.providersByServerId.values()) {
      if (provider.senderId === senderId) {
        closedServerIds.push(provider.serverId);
        this.closeProvider(provider.serverId, reason, options);
      }
    }
    return closedServerIds;
  }

  public closeAll(reason: TunnelProviderClosedReason): void {
    for (const serverId of this.providersByServerId.keys()) {
      this.closeProvider(serverId, reason);
    }
  }

  private resolveProvider(
    senderId: number,
    ref: { serverId: string; providerId: string },
  ): { ok: true; value: ProviderState } | TunnelInvokeResult<never> {
    const provider = this.providersByServerId.get(ref.serverId);
    if (!provider) {
      return failure("provider_unavailable", "No tunnel provider is registered for this host.");
    }
    if (provider.senderId !== senderId || provider.providerId !== ref.providerId) {
      return failure("not_owner", "This window does not own the host's tunnel provider.");
    }
    return { ok: true, value: provider };
  }

  private resolveStream(
    senderId: number,
    ref: TunnelStreamRef,
  ): { ok: true; value: StreamState } | TunnelInvokeResult<never> {
    const provider = this.resolveProvider(senderId, ref);
    if (!provider.ok) return provider;
    const state = provider.value.streams.get(ref.streamId);
    if (!state) {
      return failure("unknown_stream", "The stream is not open.");
    }
    return { ok: true, value: state };
  }

  private ref(state: StreamState): TunnelStreamRef {
    return {
      serverId: state.provider.serverId,
      providerId: state.provider.providerId,
      streamId: state.streamId,
    };
  }

  private send(provider: ProviderState, event: TunnelBridgeEvent): boolean {
    if (this.emit(provider.senderId, event)) {
      return true;
    }
    this.closeProvider(provider.serverId, "disconnected", { notifyRenderer: false });
    return false;
  }

  private drainWrites(state: StreamState): void {
    while (state.phase === "open" && state.pendingWrites.length > 0 && state.sendCredit > 0) {
      const pending = state.pendingWrites[0];
      const remaining = pending.data.byteLength - pending.offset;
      const size = Math.min(remaining, state.sendCredit, state.provider.limits.maxDataBytes);
      const chunk = pending.data.slice(pending.offset, pending.offset + size);
      state.sendCredit -= size;
      pending.offset += size;
      const delivered = this.send(state.provider, {
        name: "network_tunnel_stream_data",
        payload: { ...this.ref(state), data: chunk },
      });
      if (!delivered) {
        return;
      }
      if (pending.offset >= pending.data.byteLength) {
        state.pendingWrites.shift();
        pending.callback();
      }
    }
  }

  private scheduleCreditFlush(state: StreamState): void {
    if (state.creditFlushScheduled) return;
    state.creditFlushScheduled = true;
    queueMicrotask(() => {
      state.creditFlushScheduled = false;
      if (state.phase !== "open" || state.pendingCredit === 0) return;
      const credit = state.pendingCredit;
      state.pendingCredit = 0;
      this.send(state.provider, {
        name: "network_tunnel_stream_credit",
        payload: { ...this.ref(state), credit },
      });
    });
  }

  /**
   * Proxy side or main itself ends the stream: tell the renderer, never echo back.
   * `notifySink` is for closes main decided on its own (timeouts, sequence
   * violations); the proxy then releases Chromium's socket as well.
   */
  private closeStreamFromMain(
    state: StreamState,
    reason: number,
    options: { notifySink?: boolean } = {},
  ): void {
    const provider = state.provider;
    this.detachStream(state, new TunnelStreamError(reason));
    if (this.providersByServerId.get(provider.serverId) === provider) {
      this.send(provider, {
        name: "network_tunnel_stream_close",
        payload: { ...this.ref(state), reason },
      });
    }
    if (options.notifySink) {
      state.sink.onClose(reason);
    }
  }

  private detachStream(state: StreamState, error: TunnelStreamError): void {
    if (state.phase === "closed") return;
    state.phase = "closed";
    this.cancelTimeout(state.connectTimer);
    state.connectTimer = null;
    state.provider.streams.delete(state.streamId);
    for (const pending of state.pendingWrites.splice(0)) {
      pending.callback(error);
    }
  }
}
