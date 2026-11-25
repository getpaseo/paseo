import type { Server as HttpServer } from "node:http";
import { createServer, isIPv4, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

export function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

export function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${formatHostForHttpUrl(listenTarget.host)}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

export function splitListen(listen: string): [main: string, ...extras: string[]] {
  const [main = "", ...extras] = listen.split(",").map((entry) => entry.trim());
  for (const entry of extras) parseExtra(entry);
  return [main, ...new Set(extras)];
}

function parseExtra(address: string) {
  const target = parseListenString(address);
  if (
    target.type !== "tcp" ||
    target.port < 1 ||
    target.port > 65535 ||
    !/^.+:\d+$/.test(address)
  ) {
    throw new Error(`Invalid extra TCP listen address: ${address}`);
  }
  return target;
}

export function createExtraListeners(http: HttpServer, retryMs = 2_000) {
  const active = new Map<string, ReturnType<typeof open>>();
  function open(address: string) {
    const { port, host } = parseExtra(address);
    const sockets = new Set<Socket>();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      http.emit("connection", socket);
    });
    function listen() {
      return new Promise<void>((resolve) => {
        const settled = () => {
          server.off("listening", settled);
          server.off("error", settled);
          server.off("close", settled);
          resolve();
        };
        server.once("listening", settled);
        server.once("error", settled);
        server.once("close", settled);
        server.listen(port, host);
      });
    }
    server.on("error", () => {
      if (!stopped) retry = setTimeout(() => void listen(), retryMs).unref();
    });
    return {
      ready: listen(),
      state: () => (server.listening ? ("listening" as const) : ("waiting" as const)),
      close() {
        stopped = true;
        clearTimeout(retry);
        server.close();
        // Let the request that removed this listener queue its response first.
        setImmediate(() => {
          for (const socket of sockets) socket.destroy();
        });
      },
    };
  }
  return {
    async apply(addresses: readonly string[]) {
      const desired = new Set(addresses);
      for (const [address, listener] of active) {
        if (desired.has(address)) continue;
        listener.close();
        active.delete(address);
      }
      for (const address of desired) {
        if (!active.has(address)) active.set(address, open(address));
      }
      await Promise.all(Array.from(active.values(), (listener) => listener.ready));
    },
    status() {
      return Array.from(active, ([address, listener]) => ({ address, state: listener.state() }));
    },
  };
}

function isTailnetIPv4(address: string) {
  const [first, second = ""] = address.split(".");
  return isIPv4(address) && first === "100" && Number(second) >= 64 && Number(second) <= 127;
}

// Saved Tailscale listeners use an extra address in the Tailscale range on the main
// port. The entry can outlive the interface or its current IP.
function isTailscaleListener(
  target: ReturnType<typeof parseExtra>,
  port: number,
  ip: string | null,
) {
  return target.port === port && (target.host === ip || isTailnetIPv4(target.host));
}

export function findTailscaleAddress(readInterfaces = networkInterfaces) {
  for (const [name, addresses] of Object.entries(readInterfaces())) {
    if (!addresses) continue;
    if (
      !/^tailscale/i.test(name) &&
      !addresses.some(({ address }) => address.toLowerCase().startsWith("fd7a:115c:a1e0:"))
    ) {
      continue;
    }
    const v4 = addresses.find(({ address }) => isTailnetIPv4(address));
    if (v4) return v4.address;
  }
  return null;
}

export function createDaemonListeners(options: {
  http: HttpServer;
  listen: string;
  overridden: boolean;
  getMain: () => ListenTarget | null;
  getTailscaleAddress?: () => string | null;
}) {
  const { http, listen, overridden, getMain, getTailscaleAddress = findTailscaleAddress } = options;
  const [startupMain] = splitListen(listen);
  const extras = createExtraListeners(http);
  let stopped = false;
  function describeTailscale() {
    const main = getMain();
    const ip = getTailscaleAddress();
    const extraListeners = extras.status();
    const configured = extraListeners.flatMap((listener) => {
      const target = parseExtra(listener.address);
      if (main?.type !== "tcp" || !isTailscaleListener(target, main.port, ip)) return [];
      return [{ target, state: listener.state }];
    });
    const current = configured.find(({ target }) => target.host === ip);
    const shown = current ?? configured[0];
    const managedByMain =
      main?.type === "tcp" && ip !== null && [ip, "0.0.0.0", "::"].includes(main.host);
    let address = shown ? formatListenTarget(shown.target) : null;
    if (managedByMain) address = `${ip}:${main.port}`;
    let state: "on" | "off" | "waiting" | "unavailable" = ip ? "off" : "unavailable";
    if (shown) state = current?.state === "listening" ? "on" : "waiting";
    if (managedByMain) state = "on";

    let lockedBy: "main" | "launch" | undefined;
    if (managedByMain || main?.type !== "tcp") lockedBy = "main";
    if (overridden) lockedBy = "launch";
    return {
      main,
      configured,
      tailscale: {
        ip,
        address,
        state,
        ...(lockedBy ? { lockedBy } : {}),
        ...(main && main.type !== "tcp" ? { mainIsSocket: true as const } : {}),
      },
      extraListeners,
    };
  }

  return {
    status(localEndpoint?: string) {
      const { tailscale, configured, extraListeners } = describeTailscale();
      const disconnectsCurrentConnection =
        !tailscale.lockedBy &&
        configured.some(({ target }) => formatListenTarget(target) === localEndpoint);
      return {
        tailscale: { ...tailscale, disconnectsCurrentConnection },
        extraListeners,
      };
    },
    async apply(persisted: string | undefined) {
      const [main, ...addresses] = splitListen(overridden ? listen : (persisted ?? listen));
      const before = extras.status().map(({ address }) => address);
      if (!stopped) await extras.apply(addresses);
      return {
        restartRequired: main !== startupMain,
        applied: JSON.stringify(before) !== JSON.stringify(addresses),
      };
    },
    stop() {
      stopped = true;
      return extras.apply([]);
    },
    edit(persisted: string | undefined, enabled: boolean) {
      const { main, tailscale } = describeTailscale();
      if (stopped || tailscale.lockedBy || main?.type !== "tcp") {
        throw new Error("Tailscale listen address cannot be changed");
      }
      const [first, ...addresses] = splitListen(persisted ?? listen);
      if (enabled) {
        if (!tailscale.ip) throw new Error("Tailscale is not running");
        const alreadyConfigured = addresses.some((entry) => {
          const target = parseExtra(entry);
          return target.host === tailscale.ip && target.port === main.port;
        });
        if (!alreadyConfigured) addresses.push(`${tailscale.ip}:${main.port}`);
        return [first, ...addresses].join(",");
      }
      const remaining = addresses.filter(
        (entry) => !isTailscaleListener(parseExtra(entry), main.port, tailscale.ip),
      );
      return [first, ...remaining].join(",");
    },
  };
}
