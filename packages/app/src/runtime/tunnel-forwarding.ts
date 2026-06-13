import { TunnelStreamOpcode, type TunnelStreamFrame } from "@getpaseo/protocol/binary-frames/index";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { listenToDesktopEvent } from "@/desktop/electron/events";

/**
 * Renderer side of the TCP port-forward — the bridge that makes a remote dev
 * server reachable at `http://localhost:<port>` on this machine by riding the
 * daemon WebSocket we already hold (no second connection).
 *
 * Three hops per byte:
 *   browser ⇄ main-process loopback listener  (desktop IPC: `paseo:event:tunnel` / `*_tunnel_*`)
 *           ⇄ this controller
 *           ⇄ daemon client tunnel frames     (existing WebSocket)
 *           ⇄ daemon `127.0.0.1:<port>`
 *
 * Desktop-only: it needs a main-process TCP listener, which plain web and
 * native can't provide.
 */

/** The slice of DaemonClient this controller needs — kept structural to avoid coupling. */
export interface TunnelCapableClient {
  openTunnelStream(streamId: string, port: number): void;
  sendTunnelData(streamId: string, payload: Uint8Array): void;
  closeTunnelStream(streamId: string, reason?: number): void;
  onTunnelFrame(handler: (frame: TunnelStreamFrame) => void): () => void;
}

interface TunnelEventPayload {
  listenerId: string;
  streamId: string;
  kind: "connection" | "data" | "close";
  binaryBase64?: string;
}

interface ForwardState {
  listenerId: string;
  serverId: string;
  client: TunnelCapableClient;
  port: number;
  localPort: number;
}

const forwardsByKey = new Map<string, ForwardState>();
const forwardsByListener = new Map<string, ForwardState>();
const clientSubscriptions = new Map<TunnelCapableClient, () => void>();
let desktopSubscribed = false;
let listenerSeq = 0;
let instanceId: string | null = null;

function forwardKey(serverId: string, port: number): string {
  return `${serverId}:${port}`;
}

/**
 * A per-renderer-process id so listenerIds are unique across windows (the
 * desktop broadcasts tunnel events to every window and each filters by the
 * listenerIds it owns). Computed lazily — only on the Electron tunnel path — so
 * `crypto` is never touched at import time on native.
 */
function getInstanceId(): string {
  if (!instanceId) {
    instanceId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `inst-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
  return instanceId;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function ensureDesktopSubscription(): void {
  if (desktopSubscribed) {
    return;
  }
  desktopSubscribed = true;
  void listenToDesktopEvent<TunnelEventPayload>("tunnel", handleDesktopTunnelEvent);
  // Reclaim this window's loopback listeners when it closes/reloads, so they
  // don't leak (and hold their ports) until app quit.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", closeAllForwards);
  }
}

function closeAllForwards(): void {
  for (const forward of forwardsByListener.values()) {
    void invokeDesktopCommand("close_tunnel_listener", { listenerId: forward.listenerId });
  }
  forwardsByKey.clear();
  forwardsByListener.clear();
  for (const unsubscribe of clientSubscriptions.values()) {
    unsubscribe();
  }
  clientSubscriptions.clear();
}

function handleDesktopTunnelEvent(payload: TunnelEventPayload): void {
  const forward = forwardsByListener.get(payload.listenerId);
  if (!forward) {
    // Belongs to another window's listener; ignore.
    return;
  }
  if (payload.kind === "connection") {
    forward.client.openTunnelStream(payload.streamId, forward.port);
    return;
  }
  if (payload.kind === "data") {
    if (payload.binaryBase64) {
      forward.client.sendTunnelData(payload.streamId, base64ToBytes(payload.binaryBase64));
    }
    return;
  }
  // close (browser side ended)
  forward.client.closeTunnelStream(payload.streamId);
}

function ensureClientSubscription(client: TunnelCapableClient): void {
  if (clientSubscriptions.has(client)) {
    return;
  }
  const unsubscribe = client.onTunnelFrame((frame) => {
    if (frame.opcode === TunnelStreamOpcode.Data) {
      void invokeDesktopCommand("send_tunnel_data", {
        streamId: frame.streamId,
        binaryBase64: bytesToBase64(frame.payload),
      });
      return;
    }
    if (frame.opcode === TunnelStreamOpcode.Close) {
      void invokeDesktopCommand("close_tunnel_stream", { streamId: frame.streamId });
    }
  });
  clientSubscriptions.set(client, unsubscribe);
}

/** Drop a client's tunnel-frame subscription once no forward references it. */
function releaseClientIfUnused(client: TunnelCapableClient): void {
  for (const forward of forwardsByKey.values()) {
    if (forward.client === client) {
      return;
    }
  }
  const unsubscribe = clientSubscriptions.get(client);
  if (unsubscribe) {
    unsubscribe();
    clientSubscriptions.delete(client);
  }
}

/**
 * Ensure a loopback forward exists for `port` on `serverId`'s daemon and return
 * the local URL to open. Idempotent per (serverId, port). Throws if the local
 * port can't be bound (e.g. already in use) — the caller should surface that and
 * fall back to the direct URL.
 */
export async function ensureServiceForward(input: {
  serverId: string;
  client: TunnelCapableClient;
  port: number;
}): Promise<string> {
  const key = forwardKey(input.serverId, input.port);
  const existing = forwardsByKey.get(key);
  if (existing) {
    if (existing.client !== input.client) {
      const previousClient = existing.client;
      existing.client = input.client;
      ensureClientSubscription(input.client);
      releaseClientIfUnused(previousClient);
    }
    return `http://localhost:${existing.localPort}`;
  }

  ensureDesktopSubscription();
  ensureClientSubscription(input.client);

  const listenerId = `tunnel-${getInstanceId()}-${input.serverId}-${input.port}-${(listenerSeq += 1)}`;
  const { port: localPort } = await invokeDesktopCommand<{ port: number }>("open_tunnel_listener", {
    listenerId,
    port: input.port,
  });

  const forward: ForwardState = {
    listenerId,
    serverId: input.serverId,
    client: input.client,
    port: input.port,
    localPort,
  };
  forwardsByKey.set(key, forward);
  forwardsByListener.set(listenerId, forward);
  return `http://localhost:${localPort}`;
}
