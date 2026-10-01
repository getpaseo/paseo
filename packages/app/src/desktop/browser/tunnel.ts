import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { tunnelHost } from "./tunnel-host";
import { useSessionStore } from "@/stores/session-store";
import { hostSupportsFeature } from "@/runtime/host-features";
import { useBrowserStore } from "./store";

interface Tunnel {
  key: string;
  client: DaemonClient;
  workspaceId: string;
  browserId: string;
  origin: string;
  localOrigin: string;
}
const tunnels = new Map<string, Tunnel>();
const origins = new Map<string, Promise<string>>();
const connections = new Map<
  string,
  { ready: Promise<string>; release: () => Promise<void>; incoming: Promise<void> }
>();
let listening: Promise<unknown> | undefined;
let nextTunnel = 0;

useBrowserStore.subscribe((state, previous) => {
  for (const browser of Object.values(previous.browsersById)) {
    if (state.browsersById[browser.browserId]) continue;
    for (const [id, tunnel] of tunnels) {
      if (tunnel.browserId !== (browser.remoteBrowserId ?? browser.browserId)) continue;
      tunnels.delete(id);
      origins.delete(tunnel.key);
      void tunnelHost.stop(id).catch(() => {});
    }
  }
});

export function isHostLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.hostname.endsWith(".localhost"))
    );
  } catch {
    return false;
  }
}

async function listen() {
  listening ??= tunnelHost
    .onSocket((event) => {
      const close = () => {
        const connection = connections.get(event.connectionId);
        connections.delete(event.connectionId);
        void tunnelHost.close(event.connectionId).catch(() => {});
        void connection?.release().catch(() => {});
      };
      const tunnel = tunnels.get(event.tunnelId);
      if (!tunnel) return close();
      if (event.kind === "open") {
        const observation = tunnel.client.observeBrowserTunnel(tunnel);
        const ready = observation.ready.then((result) => {
          if (!result.subscriptionId)
            throw new Error(result.error ?? "Website connection unavailable");
          return result.subscriptionId;
        });
        const connection = {
          ready,
          release: () => observation.release(),
          incoming: Promise.resolve(),
        };
        connections.set(event.connectionId, connection);
        observation.subscribe({
          snapshot: () => {},
          update: (message) => {
            if (message.type !== "browser.tunnel.data") return;
            connection.incoming = connection.incoming
              .then(async () => {
                if (message.payload.error) throw new Error(message.payload.error);
                if (message.payload.dataBase64) {
                  await tunnelHost.write(event.connectionId, message.payload.dataBase64);
                  await tunnel.client.operateBrowserTunnel({
                    subscriptionId: await ready,
                    operation: "resume",
                  });
                }
                if (message.payload.ended) close();
                return undefined;
              })
              .catch(close);
          },
          error: close,
        });
        void ready
          .then(async (subscriptionId) => {
            await tunnel.client.operateBrowserTunnel({ subscriptionId, operation: "resume" });
            await tunnelHost.resume(event.connectionId);
            return undefined;
          })
          .catch(close);
      } else if (event.kind === "data") {
        const connection = connections.get(event.connectionId);
        if (!connection) return close();
        void connection.ready
          .then(async (subscriptionId) => {
            await tunnel.client.operateBrowserTunnel({
              subscriptionId,
              operation: "write",
              dataBase64: event.dataBase64,
            });
            await tunnelHost.resume(event.connectionId);
            return undefined;
          })
          .catch(close);
      } else close();
    })
    .catch((error) => {
      listening = undefined;
      throw error;
    });
  await listening;
}

export async function resolveBrowserUrl(input: {
  client: DaemonClient;
  serverId: string;
  workspaceId: string;
  browserId: string;
  url: string;
}): Promise<string> {
  if (!isHostLocalUrl(input.url)) return input.url;
  if (
    !hostSupportsFeature(
      useSessionStore.getState().sessions[input.serverId]?.serverInfo,
      "browserTunnel",
    )
  )
    throw new Error("Update the PandaOS host to open host-local websites");
  const url = new URL(input.url);
  const key = [input.serverId, input.workspaceId, input.browserId, url.origin].join("\0");
  let origin = origins.get(key);
  if (!origin) {
    origin = (async () => {
      await listen();
      const id = "website-" + ++nextTunnel;
      const tunnel: Tunnel = { ...input, key, origin: url.origin, localOrigin: "" };
      tunnels.set(id, tunnel);
      try {
        const port = await tunnelHost.start(id);
        if (!tunnels.has(id)) {
          await tunnelHost.stop(id);
          throw new Error("Browser tab is closed");
        }
        tunnel.localOrigin = "http://127.0.0.1:" + port;
        return tunnel.localOrigin;
      } catch (error) {
        tunnels.delete(id);
        throw error;
      }
    })();
    origins.set(key, origin);
    void origin.catch(() => origins.delete(key));
  }
  return (await origin) + url.pathname + url.search + url.hash;
}

export function originalBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const tunnel of tunnels.values()) {
      if (url.origin === tunnel.localOrigin)
        return tunnel.origin + url.pathname + url.search + url.hash;
    }
  } catch {}
  return value;
}
