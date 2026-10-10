import { NetworkTunnelError, type NetworkTunnelStream } from "@getpaseo/client";
import { z } from "zod";
import {
  ipcAckSchema,
  ipcFailureSchema,
  requireIpcSuccess,
  routingDesktop,
  type NetworkTunnelOpener,
  type RoutingDesktop,
} from "./contract";

const identitySchema = z.object({
  serverId: z.string(),
  providerId: z.uuid(),
  streamId: z.uuid(),
});
const eventSchemas = {
  open: identitySchema.extend({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
  }),
  data: identitySchema.extend({ data: z.instanceof(Uint8Array) }),
  credit: identitySchema.extend({ credit: z.number().int().positive().max(0xffffffff) }),
  close: identitySchema.extend({ reason: z.number().int().min(0).max(8) }),
};
interface StreamState {
  stream: NetworkTunnelStream | null;
  connected: boolean;
  outgoing: number;
  incoming: number;
  pending: number;
  cancelled: boolean;
  queue: Promise<void>;
}
export interface TunnelProvider {
  close(): Promise<void>;
  onClosed(listener: () => void): () => void;
}

/** IPC acknowledgements never return credit: only the destination's credit event does. */
export async function openTunnelProvider(input: {
  serverId: string;
  openTunnel: NetworkTunnelOpener;
  desktop?: RoutingDesktop;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
}): Promise<TunnelProvider> {
  const desktop = input.desktop ?? routingDesktop;
  const tunnel = await input.openTunnel();
  const { initialWindowBytes: windowBytes, maxDataBytes, maxStreams } = tunnel.limits;
  // Count invocations: two windows of one-byte data/credit frames plus control messages.
  const maxPendingIpcInvocations = windowBytes * 2 + 4;
  const streams = new Map<string, StreamState>();
  const unlisten: Array<() => void> = [];
  let providerId: string | null = null;
  let stopped = false;
  let closing: Promise<void> | null = null;
  const closedListeners = new Set<() => void>();
  function onClosed(listener: () => void): () => void {
    if (stopped) {
      listener();
      return () => {};
    }
    closedListeners.add(listener);
    return () => {
      closedListeners.delete(listener);
    };
  }
  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    for (const dispose of unlisten.splice(0)) dispose();
    streams.clear();
    closing = (async () => {
      await Promise.resolve();
      try {
        if (providerId)
          await desktop.invoke("network_tunnel_provider_unregister", {
            serverId: input.serverId,
            providerId,
          });
      } finally {
        await tunnel.close();
      }
    })();
    for (const listener of closedListeners) listener();
    closedListeners.clear();
    return closing;
  }
  async function fail(error: unknown): Promise<void> {
    input.onError?.(error);
    try {
      await close();
    } catch (cleanupError) {
      input.onError?.(cleanupError);
    }
  }
  function closeLocalStream(state: StreamState, streamId: string, reason: number) {
    if (state.cancelled) return;
    state.cancelled = true;
    if (streams.get(streamId) === state) streams.delete(streamId);
    state.stream?.close(reason);
  }
  function send(
    state: StreamState,
    streamId: string,
    operation: string,
    payload: Record<string, unknown> = {},
  ) {
    if (++state.pending > maxPendingIpcInvocations) {
      void fail(new Error("Tunnel IPC queue exceeded its window"));
      return;
    }
    state.queue = state.queue
      .then(async () => {
        if (stopped || (state.cancelled && operation !== "close")) return;
        const result = ipcAckSchema.parse(
          await desktop.invoke(`network_tunnel_stream_${operation}`, {
            serverId: input.serverId,
            providerId,
            streamId,
            ...payload,
          }),
        );
        if (!result.ok && result.error.code === "unknown_stream") {
          closeLocalStream(state, streamId, 0);
          return;
        }
        if (!result.ok && result.error.code === "protocol_error") {
          closeLocalStream(state, streamId, 8);
          return;
        }
        requireIpcSuccess(result);
        return;
      })
      .catch(fail)
      .finally(() => {
        state.pending--;
      });
  }
  function openStream(event: z.infer<typeof eventSchemas.open>) {
    const state: StreamState = {
      stream: null,
      connected: false,
      outgoing: windowBytes,
      incoming: windowBytes,
      pending: 0,
      cancelled: false,
      queue: Promise.resolve(),
    };
    try {
      if (streams.has(event.streamId))
        throw new NetworkTunnelError("duplicate_stream", "Duplicate stream");
      if (streams.size >= maxStreams)
        throw new NetworkTunnelError("stream_limit", "Stream limit reached");
      streams.set(event.streamId, state);
      state.stream = tunnel.openStream(
        { streamId: event.streamId, host: event.host, port: event.port },
        {
          onConnected() {
            if (stopped || state.cancelled) return;
            if (state.connected) return fail(new Error("Duplicate tunnel Connected"));
            state.connected = true;
            send(state, event.streamId, "connected");
          },
          onData(data) {
            if (stopped || state.cancelled) return;
            if (
              !state.connected ||
              data.byteLength === 0 ||
              data.byteLength > maxDataBytes ||
              data.byteLength > state.incoming
            )
              return fail(new Error("Invalid tunnel receive credit"));
            state.incoming -= data.byteLength;
            send(state, event.streamId, "data", { data });
          },
          onCredit(credit) {
            if (stopped || state.cancelled) return;
            if (
              !state.connected ||
              !Number.isInteger(credit) ||
              credit <= 0 ||
              state.outgoing + credit > windowBytes
            )
              return fail(new Error("Invalid tunnel send credit"));
            state.outgoing += credit;
            send(state, event.streamId, "credit", { credit });
          },
          onClose(reason) {
            if (stopped || streams.get(event.streamId) !== state) return;
            send(state, event.streamId, "close", { reason });
            streams.delete(event.streamId);
          },
        },
      );
    } catch (error) {
      const previous = streams.get(event.streamId);
      if (previous) closeLocalStream(previous, event.streamId, 1);
      const reason = error instanceof NetworkTunnelError && error.code === "stream_limit" ? 7 : 1;
      send(state, event.streamId, "close", { reason });
    }
  }
  async function listen(event: string, handler: (payload: unknown) => void): Promise<void> {
    if (stopped) return;
    const dispose = await desktop.listen(event, handler);
    if (stopped) dispose();
    else unlisten.push(dispose);
  }
  try {
    if (input.signal?.aborted) {
      await close();
      return { close, onClosed };
    }
    const abort = () => {
      void close().catch(fail);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    unlisten.push(() => input.signal?.removeEventListener("abort", abort));
    const removeClosedListener = tunnel.onClosed(() => {
      void close().catch(fail);
    });
    if (stopped) removeClosedListener();
    else unlisten.push(removeClosedListener);
    for (const operation of ["open", "data", "credit", "close"] as const) {
      await listen(`network_tunnel_stream_${operation}`, (raw) => {
        if (stopped || !providerId) return;
        // A different provider/window generation cannot address this subscription.
        const identity = z.object({ serverId: z.string(), providerId: z.string() }).safeParse(raw);
        if (
          !identity.success ||
          identity.data.serverId !== input.serverId ||
          identity.data.providerId !== providerId
        )
          return;
        try {
          if (operation === "open") {
            openStream(eventSchemas.open.parse(raw));
            return;
          }
          const event = eventSchemas[operation].parse(raw);
          const state = streams.get(event.streamId);
          if (!state?.stream) return; // Frames already in flight when a stream closed.
          if ("reason" in event) {
            closeLocalStream(state, event.streamId, event.reason);
            return;
          }
          if (!state.connected) throw new Error("Tunnel data before Connected");
          if ("data" in event) {
            const bytes = event.data.byteLength;
            if (!bytes || bytes > maxDataBytes || bytes > state.outgoing)
              throw new Error("Tunnel send window exceeded");
            state.outgoing -= bytes;
            state.stream.write(event.data);
          } else {
            if (state.incoming + event.credit > windowBytes)
              throw new Error("Tunnel receive window exceeded");
            state.incoming += event.credit;
            state.stream.consume(event.credit);
          }
        } catch (error) {
          void fail(error);
        }
      });
    }
    await listen("network_tunnel_provider_closed", (raw) => {
      const event = z
        .object({
          serverId: z.string(),
          providerId: z.string(),
          reason: z.enum(["unregistered", "disabled", "disconnected", "protocol_error"]),
        })
        .safeParse(raw);
      if (
        event.success &&
        event.data.serverId === input.serverId &&
        event.data.providerId === providerId
      )
        void close().catch(fail);
    });
    if (stopped) return { close, onClosed };
    const registration = requireIpcSuccess(
      z.union([z.object({ ok: z.literal(true), providerId: z.uuid() }), ipcFailureSchema]).parse(
        await desktop.invoke("network_tunnel_provider_register", {
          serverId: input.serverId,
          subscriptionId: tunnel.subscriptionId,
          ...tunnel.limits,
        }),
      ),
    );
    providerId = registration.providerId;
    if (stopped) {
      await desktop.invoke("network_tunnel_provider_unregister", {
        serverId: input.serverId,
        providerId,
      });
      await close();
    }
    return { close, onClosed };
  } catch (error) {
    await close();
    throw error;
  }
}
