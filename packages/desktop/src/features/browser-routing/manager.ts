import { createHash } from "node:crypto";
import type {
  BrowserRoutingHostSettings,
  BrowserRoutingSettings,
  DesktopSettingsStore,
} from "../../settings/desktop-settings.js";
import { PASEO_BROWSER_PROFILE_PARTITION, type BrowserProfileSession } from "../browser-profile.js";
import {
  BROWSER_PROXY_LOOPBACK_HOST,
  PROXY_AUTH_REALM,
  startLocalBrowserProxy,
  type LocalBrowserProxy,
  type LocalBrowserProxyOptions,
  type ProxyCredential,
} from "./local-proxy.js";
import {
  TunnelBridge,
  type TunnelBridgeEvent,
  type TunnelProviderChange,
} from "./tunnel-bridge.js";

export const BROWSER_ROUTING_CHANGED_EVENT = "browser_routing_changed";
export const BROWSER_ROUTING_PROVIDER_READY_EVENT = "browser_routing_provider_ready";
// A second `login` for the same request within this window means the proxy
// refused what we answered; Chromium would otherwise retry 32 times.
const LOGIN_RETRY_WINDOW_MS = 10_000;

export interface ProxyLoginAuthInfo {
  isProxy: boolean;
  scheme: string;
  host: string;
  port: number;
  realm: string;
}

export type ProxyLoginDecision =
  | { kind: "answer"; credential: ProxyCredential }
  | { kind: "cancel" }
  | { kind: "ignore" };

export interface RoutedBrowserSession extends BrowserProfileSession {
  setProxy(config: { proxyRules: string; proxyBypassRules: string }): Promise<void>;
}

export interface BrowserRoutingManagerDependencies {
  settings: Pick<DesktopSettingsStore, "getBrowserRouting" | "setBrowserRoutingHost">;
  sessions: { fromPartition(partition: string): RoutedBrowserSession };
  /** Caches the proxy credential in the session (net.request answering `login`). */
  warmUp(input: { session: RoutedBrowserSession; credential: ProxyCredential }): Promise<void>;
  emit(senderId: number, event: string, payload: unknown): boolean;
  broadcast(event: string, payload: unknown): void;
  startProxy?: (options: LocalBrowserProxyOptions) => Promise<LocalBrowserProxy>;
  log?: (level: "info" | "warn", event: string, details: Record<string, unknown>) => void;
}

export type ResolvePartitionResult =
  | { ok: true; partition: string }
  | { ok: false; error: { code: "routing_disabled" | "not_ready"; message: string } };

export type SetEnabledResult =
  | { ok: true }
  | { ok: false; error: { code: "setup_failed"; message: string } };

interface HostRoute {
  readonly serverId: string;
  readonly partition: string;
  proxy: LocalBrowserProxy | null;
  /** Exists only once `proxy` listens; see `setupRoute`. */
  session: RoutedBrowserSession | null;
  /** `session.setProxy` resolved against `proxy`. */
  proxied: boolean;
  /** Credential cached and host enabled: webviews may attach. */
  ready: boolean;
  /** The one setup running for this route; every other caller waits for it. */
  setup: Promise<void> | null;
}

export function browserRoutingPartitionForServer(serverId: string): string {
  const hash = createHash("sha256").update(serverId).digest("hex").slice(0, 16);
  return `${PASEO_BROWSER_PROFILE_PARTITION}-via-${hash}`;
}

/**
 * Per-host routing: one persistent Electron session per routed daemon, pointed at a
 * local proxy whose streams go through the renderer that owns that daemon's client.
 * A partition is only handed to the renderer after `setProxy` resolved and the
 * credential is cached, because a session without a proxy leaves through the local
 * network.
 *
 * Every routed session is obtained here, never from `session.fromPartition`
 * directly: the proxy listens first, the session is created, and `setProxy` runs
 * at once. A disabled host keeps its proxy listening, answering 503 to everything,
 * so its session never points at a port another process could take.
 */
export class BrowserRoutingManager {
  public readonly bridge: TunnelBridge;
  private readonly routesByServerId = new Map<string, HostRoute>();
  /** Renderers that passed the routing IPC trust gate and may own a DaemonClient. */
  private readonly trustedRendererIds = new Set<number>();
  private hosts: BrowserRoutingSettings = {};
  private loaded: Promise<void> | null = null;
  /** Set first thing in `shutdown`: no route is materialized or published after it. */
  private shutDown = false;
  private readonly answeredLogins = new Map<string, number>();
  private readonly deps: BrowserRoutingManagerDependencies;
  private readonly startProxy: NonNullable<BrowserRoutingManagerDependencies["startProxy"]>;
  private readonly log: NonNullable<BrowserRoutingManagerDependencies["log"]>;

  public constructor(deps: BrowserRoutingManagerDependencies) {
    this.deps = deps;
    this.startProxy = deps.startProxy ?? startLocalBrowserProxy;
    this.log = deps.log ?? (() => {});
    this.bridge = new TunnelBridge({
      emit: (senderId, event: TunnelBridgeEvent) => deps.emit(senderId, event.name, event.payload),
      log: (event, details) => this.log("info", `tunnel.${event}`, details),
      onProviderChange: (change) => this.announceProviderChange(change),
    });
  }

  /** Loads persisted hosts and brings every enabled route up before webviews can ask. */
  public async initialize(): Promise<void> {
    await this.ensureLoaded();
    await Promise.all(
      Object.entries(this.hosts)
        .filter(([, host]) => host.enabled)
        .map(async ([serverId]) => {
          try {
            await this.ensureRoute(serverId);
          } catch (error) {
            this.log("warn", "route.startup-failed", { serverId, error: String(error) });
          }
        }),
    );
  }

  public async isEnabled(serverId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.hosts[serverId]?.enabled === true;
  }

  public async setEnabled(serverId: string, enabled: boolean): Promise<SetEnabledResult> {
    await this.ensureLoaded();
    const partition = this.hosts[serverId]?.partition ?? browserRoutingPartitionForServer(serverId);
    if (enabled) {
      await this.persistHost(serverId, { enabled: true, partition });
      try {
        await this.ensureRoute(serverId);
      } catch (error) {
        // Quitting is not a setup failure: the persisted choice stays as it is.
        if (!this.shutDown) {
          await this.persistHost(serverId, { enabled: false, partition });
          this.parkRoute(serverId);
        }
        this.log("warn", "route.setup-failed", { serverId, error: String(error) });
        return {
          ok: false,
          error: {
            code: "setup_failed",
            message: "The browser proxy for this host could not start.",
          },
        };
      }
    } else {
      await this.persistHost(serverId, { enabled: false, partition });
      this.parkRoute(serverId);
    }
    this.deps.broadcast(BROWSER_ROUTING_CHANGED_EVENT, { serverId, enabled });
    return { ok: true };
  }

  public async resolvePartition(serverId: string): Promise<ResolvePartitionResult> {
    await this.ensureLoaded();
    if (this.hosts[serverId]?.enabled !== true) {
      return {
        ok: false,
        error: { code: "routing_disabled", message: "Host network routing is off for this host." },
      };
    }
    try {
      const route = await this.ensureRoute(serverId);
      return { ok: true, partition: route.partition };
    } catch (error) {
      this.log("warn", "route.resolve-failed", { serverId, error: String(error) });
      return {
        ok: false,
        error: { code: "not_ready", message: "The browser proxy for this host is not ready." },
      };
    }
  }

  /** Partition names a webview may attach to right now: ready routes only. */
  public isReadyRoutedPartition(partition: string): boolean {
    for (const route of this.routesByServerId.values()) {
      if (route.partition === partition) {
        return route.ready;
      }
    }
    return false;
  }

  public isReadyRoutedSession(session: object): boolean {
    for (const route of this.routesByServerId.values()) {
      if (route.session === session) {
        return route.ready;
      }
    }
    return false;
  }

  /**
   * The session of every host this install ever routed, for "Clear browser data".
   * Each one is proxied before it is handed out, a disabled host's behind a proxy
   * that denies everything, and a setup already running for a host finishes first.
   */
  public async listPersistedSessions(): Promise<RoutedBrowserSession[]> {
    await this.ensureLoaded();
    const sessions: RoutedBrowserSession[] = [];
    for (const serverId of Object.keys(this.hosts).sort()) {
      const route = await this.materializeRoute(serverId, { warm: false });
      if (route.session) sessions.push(route.session);
    }
    return sessions;
  }

  /** The credential of our proxy listening on `authInfo.port`, if it is ours at all. */
  public resolveProxyCredential(authInfo: ProxyLoginAuthInfo): ProxyCredential | null {
    if (
      !authInfo.isProxy ||
      authInfo.host !== BROWSER_PROXY_LOOPBACK_HOST ||
      authInfo.scheme.toLowerCase() !== "basic" ||
      authInfo.realm !== PROXY_AUTH_REALM
    ) {
      return null;
    }
    for (const route of this.routesByServerId.values()) {
      if (route.proxy && route.proxy.port === authInfo.port) {
        return route.proxy.credential;
      }
    }
    return null;
  }

  /**
   * Decides Chromium's proxy `login` for one request. Answers our proxies only; a
   * repeat for the same request means the answer was refused, so it is cancelled
   * instead of fed back into Chromium's retry loop.
   */
  public decideProxyLogin(
    input: { authInfo: ProxyLoginAuthInfo; requestKey: string },
    now: number = Date.now(),
  ): ProxyLoginDecision {
    const credential = this.resolveProxyCredential(input.authInfo);
    if (!credential) {
      return { kind: "ignore" };
    }
    for (const [key, answeredAt] of this.answeredLogins) {
      if (now - answeredAt > LOGIN_RETRY_WINDOW_MS) this.answeredLogins.delete(key);
    }
    const key = `${input.authInfo.port}|${input.requestKey}`;
    if (this.answeredLogins.has(key)) {
      this.answeredLogins.delete(key);
      this.log("warn", "login.credential-refused", { port: input.authInfo.port });
      return { kind: "cancel" };
    }
    this.answeredLogins.set(key, now);
    return { kind: "answer", credential };
  }

  /**
   * `clearAuthCache` drops the proxy credential. Every ready route loses readiness
   * until its credential is cached again; a failure rejects so callers do not
   * reload guests against a session that cannot authenticate, and the next
   * `resolvePartition` retries the warm-up.
   */
  public async rewarmCredentials(): Promise<void> {
    const failed: string[] = [];
    await Promise.all(
      [...this.routesByServerId.values()]
        .filter((route) => route.ready)
        .map(async (route) => {
          route.ready = false;
          try {
            await this.materializeRoute(route.serverId, { warm: true });
          } catch (error) {
            failed.push(route.serverId);
            this.log("warn", "route.rewarm-failed", {
              serverId: route.serverId,
              error: String(error),
            });
          }
        }),
    );
    if (failed.length > 0) {
      throw new Error(`Browser proxy credential warm-up failed for ${failed.length} host(s).`);
    }
  }

  public handleRendererGone(senderId: number): void {
    this.trustedRendererIds.delete(senderId);
    // Releasing the providers announces the handoff to the remaining windows.
    this.bridge.closeProvidersForSender(senderId, "disconnected", { notifyRenderer: false });
  }

  /**
   * Only one window serves a host's tunnel; the others wait. A release re-emits the
   * current routing value, which waiting windows treat as a handoff signal, whether the
   * owner closed, crashed, or only lost its host connection. A registration tells the
   * other windows to reload routed tabs that failed while no provider was serving.
   */
  private announceProviderChange(change: TunnelProviderChange): void {
    if (change.kind === "released" && change.reason === "disabled") return;
    if (this.hosts[change.serverId]?.enabled !== true) return;
    const event =
      change.kind === "released"
        ? BROWSER_ROUTING_CHANGED_EVENT
        : BROWSER_ROUTING_PROVIDER_READY_EVENT;
    const payload =
      change.kind === "released"
        ? { serverId: change.serverId, enabled: true }
        : { serverId: change.serverId };
    for (const rendererId of this.trustedRendererIds) {
      if (rendererId === change.senderId) continue;
      if (!this.deps.emit(rendererId, event, payload)) this.trustedRendererIds.delete(rendererId);
    }
  }

  /** Called only after `isTrustedRenderer` accepts a routing IPC sender. */
  public noteTrustedRenderer(senderId: number): void {
    this.trustedRendererIds.add(senderId);
  }

  /**
   * Quit: closes every proxy and its sockets so nothing is left for the OS to reap.
   * A setup still running fails at its next check instead of publishing readiness
   * or leaving a listener behind; `shutdown` waits for it before closing.
   */
  public async shutdown(): Promise<void> {
    this.shutDown = true;
    this.trustedRendererIds.clear();
    this.bridge.closeAll("disconnected");
    const routes = [...this.routesByServerId.values()];
    await Promise.all(routes.map((route) => route.setup?.catch(() => {})));
    this.routesByServerId.clear();
    await Promise.all(
      routes.map(async (route) => {
        route.ready = false;
        route.proxied = false;
        await route.proxy?.close();
        route.proxy = null;
      }),
    );
  }

  private assertRunning(): void {
    if (this.shutDown) {
      throw new Error("browser routing manager is shut down");
    }
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      this.hosts = await this.deps.settings.getBrowserRouting();
    })();
    await this.loaded;
  }

  private async persistHost(serverId: string, host: BrowserRoutingHostSettings): Promise<void> {
    this.hosts = await this.deps.settings.setBrowserRoutingHost(serverId, host);
  }

  private async ensureRoute(serverId: string): Promise<HostRoute> {
    return this.materializeRoute(serverId, { warm: true });
  }

  private routeFor(serverId: string): HostRoute {
    let route = this.routesByServerId.get(serverId);
    if (!route) {
      route = {
        serverId,
        partition: this.hosts[serverId]?.partition ?? browserRoutingPartitionForServer(serverId),
        proxy: null,
        session: null,
        proxied: false,
        ready: false,
        setup: null,
      };
      this.routesByServerId.set(serverId, route);
    }
    return route;
  }

  /**
   * Brings a route to "proxied" (session behind a listening proxy) or, with `warm`,
   * to "ready" (credential cached too). Setups for one route never overlap: a
   * caller arriving during another's setup waits for it and then checks again.
   */
  private async materializeRoute(serverId: string, input: { warm: boolean }): Promise<HostRoute> {
    this.assertRunning();
    const route = this.routeFor(serverId);
    const done = () => (input.warm ? route.ready : route.proxied);
    while (route.setup) {
      await route.setup.catch(() => {});
    }
    this.assertRunning();
    if (done()) {
      return route;
    }
    const setup = this.setupRoute(route, input).finally(() => {
      if (route.setup === setup) route.setup = null;
    });
    route.setup = setup;
    await setup;
    return route;
  }

  private async setupRoute(route: HostRoute, input: { warm: boolean }): Promise<void> {
    // A retry after a failed setProxy or warm-up reuses the proxy already listening.
    const proxy =
      route.proxy ??
      (await this.startProxy({
        // A disabled host has no streams: the proxy answers 503 to everything.
        openStream: (target, sink) =>
          this.hosts[route.serverId]?.enabled === true
            ? this.bridge.openStreamFor(route.serverId, target, sink)
            : null,
        log: (event, details) =>
          this.log("info", `proxy.${event}`, { serverId: route.serverId, ...details }),
      }));
    // Shut down while the proxy was starting: do not leave it listening.
    if (this.shutDown) {
      await proxy.close();
      throw new Error("browser routing manager shut down during setup");
    }
    route.proxy = proxy;
    // The session is created only now, with the proxy listening, and pointed at it
    // before anything else runs: a session's background traffic (service workers,
    // spellcheck dictionaries) starts with the session and would otherwise leave
    // through the local network.
    const session = route.session ?? this.deps.sessions.fromPartition(route.partition);
    route.session = session;
    await session.setProxy({
      // One HTTP proxy for every URL scheme, WebSockets included (spike D1).
      proxyRules: `http://${BROWSER_PROXY_LOOPBACK_HOST}:${proxy.port}`,
      // Without this rule Chromium sends localhost and 127.0.0.1 directly.
      proxyBypassRules: "<-loopback>",
    });
    this.assertRunning();
    route.proxied = true;
    if (!input.warm) {
      return;
    }
    await this.deps.warmUp({ session, credential: proxy.credential });
    this.assertRunning();
    if (this.hosts[route.serverId]?.enabled !== true) {
      throw new Error("routing was disabled during setup");
    }
    route.ready = true;
    this.log("info", "route.ready", {
      serverId: route.serverId,
      partition: route.partition,
      port: proxy.port,
    });
  }

  /**
   * Disabled: the provider closes and webviews may no longer attach. The proxy
   * keeps listening and denies everything, so the session stays behind a port
   * that is ours.
   */
  private parkRoute(serverId: string): void {
    this.bridge.closeProvider(serverId, "disabled");
    const route = this.routesByServerId.get(serverId);
    if (route) route.ready = false;
  }
}
