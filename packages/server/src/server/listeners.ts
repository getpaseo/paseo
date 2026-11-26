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

function parseSocketTarget(listen: string): ListenTarget | undefined {
  // Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
}

export function parseListenString(listen: string): ListenTarget {
  const socket = parseSocketTarget(listen);
  if (socket) return socket;
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // host:port — TCP
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
  if (parseSocketTarget(listen)) return [listen];
  const [main = "", ...extras] = listen.split(",").map((entry) => entry.trim());
  for (const entry of extras) parseExtra(entry);
  return [main, ...new Set(extras)];
}

export function getMainListenAddress(listen: string): string {
  return parseSocketTarget(listen) ? listen : listen.split(",", 1)[0].trim();
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
    let pending: Promise<void> | null = null;
    let stopped = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      http.emit("connection", socket);
    });
    function listen(): Promise<void> {
      if (pending) return pending;
      if (stopped || server.listening) return Promise.resolve();
      clearTimeout(retry);
      retry = undefined;
      pending = new Promise<void>((resolve) => {
        const settled = () => {
          server.off("listening", onListening);
          server.off("error", settled);
          server.off("close", settled);
          pending = null;
          resolve();
        };
        const onListening = () => {
          settled();
          if (stopped) server.close();
        };
        server.once("listening", onListening);
        server.once("error", settled);
        server.once("close", settled);
        server.listen(port, host);
      });
      return pending;
    }
    server.on("error", () => {
      if (stopped) return;
      clearTimeout(retry);
      retry = setTimeout(() => void listen(), retryMs).unref();
    });
    return {
      ready: listen(),
      retry: listen,
      state: () => (server.listening ? ("listening" as const) : ("waiting" as const)),
      close() {
        stopped = true;
        clearTimeout(retry);
        retry = undefined;
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
    async retryWaiting() {
      const waiting = Array.from(active.values()).filter(
        (listener) => listener.state() === "waiting",
      );
      if (waiting.length === 0) return;
      await Promise.all(waiting.map((listener) => listener.retry()));
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

export interface TailscaleNetwork {
  addresses: readonly string[];
  otherAddresses: ReadonlySet<string>;
}

// A saved address can outlive its interface. An address assigned to a different
// interface belongs to that interface even when it is in the shared IPv4 range.
function isTailscaleListener(target: ReturnType<typeof parseExtra>, network: TailscaleNetwork) {
  return (
    !network.otherAddresses.has(target.host) &&
    (network.addresses.includes(target.host) || isTailnetIPv4(target.host))
  );
}

export function inspectTailscaleNetwork(readInterfaces = networkInterfaces): TailscaleNetwork {
  const tailscaleAddresses: string[] = [];
  const otherAddresses = new Set<string>();
  for (const [name, addresses] of Object.entries(readInterfaces())) {
    if (!addresses) continue;
    const isTailscale =
      /^tailscale/i.test(name) ||
      addresses.some(({ address }) => address.toLowerCase().startsWith("fd7a:115c:a1e0:"));
    for (const { address } of addresses) {
      if (!isTailnetIPv4(address)) continue;
      if (isTailscale) tailscaleAddresses.push(address);
      else otherAddresses.add(address);
    }
  }
  return {
    addresses: tailscaleAddresses.filter((address) => !otherAddresses.has(address)),
    otherAddresses,
  };
}

function mainTailscaleEndpoint(main: ListenTarget | null, addresses: readonly string[]) {
  if (main?.type !== "tcp") return null;
  if (addresses.includes(main.host)) return `${main.host}:${main.port}`;
  const [ip] = addresses;
  return ip && ["0.0.0.0", "::"].includes(main.host) ? `${ip}:${main.port}` : null;
}

export function createDaemonListeners(options: {
  http: HttpServer;
  listen: string;
  overridden: boolean;
  retryMs?: number;
  getMain: () => ListenTarget | null;
  getTailscaleNetwork?: () => TailscaleNetwork;
}) {
  const {
    http,
    listen,
    overridden,
    retryMs,
    getMain,
    getTailscaleNetwork = inspectTailscaleNetwork,
  } = options;
  const [startupMain] = splitListen(listen);
  const extras = createExtraListeners(http, retryMs);
  let stopped = false;

  async function applyLive(addresses: readonly string[]) {
    if (!stopped) await extras.apply(addresses);
  }

  function describeTailscale() {
    const main = getMain();
    const network = getTailscaleNetwork();
    const ip = network.addresses[0] ?? null;
    const extraListeners = extras.status();
    const configured = extraListeners.flatMap((listener) => {
      const target = parseExtra(listener.address);
      if (main?.type !== "tcp" || !isTailscaleListener(target, network)) return [];
      return [{ ...listener, target }];
    });
    const current = configured.find(
      ({ state, target }) => state === "listening" && network.addresses.includes(target.host),
    );
    const shown = current ?? configured[0];
    const mainEndpoint = mainTailscaleEndpoint(main, network.addresses);
    const address = mainEndpoint ?? (shown ? formatListenTarget(shown.target) : null);
    let state: "on" | "off" | "waiting" | "unavailable" = ip ? "off" : "unavailable";
    if (shown) state = current ? "on" : "waiting";
    if (mainEndpoint) state = "on";

    let lockedBy: "main" | "launch" | undefined;
    if (mainEndpoint || main?.type !== "tcp") lockedBy = "main";
    if (overridden) lockedBy = "launch";
    return {
      main,
      network,
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

  function status(localEndpoint?: string) {
    const { tailscale, configured, extraListeners } = describeTailscale();
    const disconnectsCurrentConnection =
      !tailscale.lockedBy &&
      configured.some(({ target }) => formatListenTarget(target) === localEndpoint);
    return {
      tailscale: { ...tailscale, disconnectsCurrentConnection },
      extraListeners,
    };
  }

  return {
    status,
    async refreshStatus(localEndpoint?: string) {
      if (!stopped) await extras.retryWaiting();
      return status(localEndpoint);
    },
    async apply(persisted: string | undefined) {
      const [main, ...addresses] = splitListen(overridden ? listen : (persisted ?? listen));
      const before = extras.status().map(({ address }) => address);
      const applicable = getMain()?.type === "tcp" ? addresses : [];
      await applyLive(applicable);
      return {
        restartRequired: main !== startupMain,
        applied: JSON.stringify(before) !== JSON.stringify(applicable),
      };
    },
    stop() {
      stopped = true;
      return extras.apply([]);
    },
    prepareTailscaleChange(
      persisted: string | undefined,
      enabled: boolean,
      localEndpoint: string | undefined,
      confirmed: boolean,
    ) {
      const { main, network, tailscale, configured, extraListeners } = describeTailscale();
      if (stopped || tailscale.lockedBy || main?.type !== "tcp") {
        throw new Error("Tailscale listen address cannot be changed");
      }
      const [first, ...saved] = splitListen(persisted ?? listen);
      const live = extraListeners.map(({ address }) => address);
      if (enabled) {
        if (configured.length) {
          return {
            confirmationRequired: false as const,
            listen: persisted ?? listen,
            apply: () => Promise.resolve(),
          };
        }
        if (!tailscale.ip) throw new Error("Tailscale is not running");
        if (parseSocketTarget(first)) throw new Error("The configured main listener is a socket");
        const address = `${tailscale.ip}:${main.port}`;
        const add = (addresses: string[]) =>
          addresses.some((entry) => formatListenTarget(parseExtra(entry)) === address)
            ? addresses
            : [...addresses, address];
        return {
          confirmationRequired: false as const,
          listen: [first, ...add(saved)].join(","),
          apply: () => applyLive(add(live)),
        };
      }
      if (
        !confirmed &&
        configured.some(({ target }) => formatListenTarget(target) === localEndpoint)
      ) {
        return { confirmationRequired: true as const };
      }
      const removed = new Set(configured.map(({ address }) => address));
      const remaining = saved.filter((entry) => !isTailscaleListener(parseExtra(entry), network));
      return {
        confirmationRequired: false as const,
        listen: [first, ...remaining].join(","),
        apply: () => applyLive(live.filter((address) => !removed.has(address))),
      };
    },
  };
}
