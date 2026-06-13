import net from "node:net";
import { BrowserWindow } from "electron";

/**
 * Main-process side of the TCP port-forward.
 *
 * The renderer holds the daemon WebSocket but cannot open OS-level TCP
 * listeners, so it asks main to bind a loopback port (the same port the remote
 * dev server uses, so absolute URLs / OAuth redirects line up). Each inbound
 * browser connection becomes a `streamId`; main shuttles its bytes to/from the
 * renderer over IPC (base64, mirroring local-transport.ts), and the renderer
 * relays them across the daemon tunnel.
 *
 * Events are broadcast to every window; the renderer filters by the listenerIds
 * it owns, so event routing stays correct without per-window routing here. (Two
 * live windows can't bind the same loopback port — the second falls back to the
 * direct URL; see docs/port-forwarding.md.)
 */

interface ListenerState {
  server: net.Server;
  streams: Map<string, net.Socket>;
}

interface TunnelEventPayload {
  listenerId: string;
  streamId: string;
  kind: "connection" | "data" | "close";
  binaryBase64?: string;
}

const listeners = new Map<string, ListenerState>();
const streamIndex = new Map<string, { listenerId: string; socket: net.Socket }>();
let nextStreamSeq = 0;

function emitTunnelEvent(payload: TunnelEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // A window can be tearing down while a stream is still delivering data;
    // sending to a destroyed webContents throws. Guard like window-manager.ts.
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      continue;
    }
    win.webContents.send("paseo:event:tunnel", payload);
  }
}

function removeStream(streamId: string): net.Socket | null {
  const entry = streamIndex.get(streamId);
  if (!entry) {
    return null;
  }
  streamIndex.delete(streamId);
  listeners.get(entry.listenerId)?.streams.delete(streamId);
  return entry.socket;
}

export function openTunnelListener(input: {
  listenerId: string;
  port: number;
}): Promise<{ port: number }> {
  const existing = listeners.get(input.listenerId);
  if (existing) {
    const address = existing.server.address();
    return Promise.resolve({
      port: address && typeof address !== "string" ? address.port : input.port,
    });
  }

  return new Promise((resolve, reject) => {
    const state: ListenerState = { server: net.createServer(), streams: new Map() };

    state.server.on("connection", (socket: net.Socket) => {
      const streamId = `tstream-${++nextStreamSeq}`;
      state.streams.set(streamId, socket);
      streamIndex.set(streamId, { listenerId: input.listenerId, socket });
      emitTunnelEvent({ listenerId: input.listenerId, streamId, kind: "connection" });

      socket.on("data", (chunk: Buffer) => {
        emitTunnelEvent({
          listenerId: input.listenerId,
          streamId,
          kind: "data",
          binaryBase64: chunk.toString("base64"),
        });
      });
      socket.on("error", () => {
        socket.destroy();
      });
      socket.on("close", () => {
        if (removeStream(streamId)) {
          emitTunnelEvent({ listenerId: input.listenerId, streamId, kind: "close" });
        }
      });
    });

    let listening = false;
    state.server.on("error", (err) => {
      if (listening) {
        // A runtime error after a successful bind: tear the listener down fully
        // (close the server, destroy sockets) so we don't orphan a live loopback
        // listener that closeAllTunnelListeners can no longer reclaim.
        closeTunnelListener({ listenerId: input.listenerId });
        return;
      }
      listeners.delete(input.listenerId);
      reject(err);
    });

    state.server.listen(input.port, "127.0.0.1", () => {
      listening = true;
      listeners.set(input.listenerId, state);
      const address = state.server.address();
      resolve({ port: address && typeof address !== "string" ? address.port : input.port });
    });
  });
}

export function sendTunnelData(input: { streamId: string; binaryBase64: string }): void {
  const entry = streamIndex.get(input.streamId);
  if (entry) {
    entry.socket.write(Buffer.from(input.binaryBase64, "base64"));
  }
}

export function closeTunnelStream(input: { streamId: string }): void {
  const socket = removeStream(input.streamId);
  if (socket) {
    // Graceful half-close: flush any buffered response bytes, then FIN. destroy()
    // would RST and discard a queued response tail (truncating HTTP responses /
    // OAuth redirects). The socket fully closes once the browser side closes.
    socket.end();
  }
}

export function closeTunnelListener(input: { listenerId: string }): void {
  const state = listeners.get(input.listenerId);
  if (!state) {
    return;
  }
  listeners.delete(input.listenerId);
  for (const [streamId, socket] of state.streams) {
    streamIndex.delete(streamId);
    socket.destroy();
  }
  state.streams.clear();
  try {
    state.server.close();
  } catch {
    // ignore
  }
}

export function closeAllTunnelListeners(): void {
  for (const state of listeners.values()) {
    for (const socket of state.streams.values()) {
      socket.destroy();
    }
    state.streams.clear();
    try {
      state.server.close();
    } catch {
      // ignore
    }
  }
  listeners.clear();
  streamIndex.clear();
}
