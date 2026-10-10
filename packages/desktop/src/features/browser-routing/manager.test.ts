import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/tunnel";
import { afterEach, describe, expect, test } from "vitest";
import { createDesktopSettingsStore } from "../../settings/desktop-settings.js";
import { startLocalBrowserProxy, type ProxyCredential } from "./local-proxy.js";
import {
  BROWSER_ROUTING_CHANGED_EVENT,
  BrowserRoutingManager,
  browserRoutingPartitionForServer,
  type RoutedBrowserSession,
} from "./manager.js";

class FakeSession implements RoutedBrowserSession {
  public readonly proxyConfigs: Array<{ proxyRules: string; proxyBypassRules: string }> = [];

  public constructor(
    public readonly partition: string,
    private readonly sequence: string[],
    private readonly gate: { started: Deferred; released: Deferred | null },
  ) {}

  public async setProxy(config: { proxyRules: string; proxyBypassRules: string }): Promise<void> {
    this.gate.started.resolve();
    if (this.gate.released) await this.gate.released.promise;
    this.proxyConfigs.push(config);
    this.sequence.push("session.proxied");
  }

  public async clearStorageData(): Promise<void> {}

  public async clearCache(): Promise<void> {}

  public async clearAuthCache(): Promise<void> {}
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Harness {
  manager: BrowserRoutingManager;
  sessions: Map<string, FakeSession>;
  warmUps: Array<{ session: FakeSession; credential: ProxyCredential }>;
  events: Array<{ senderId: number | "broadcast"; event: string; payload: unknown }>;
  /** Setup steps in the order they ran, across every host. */
  sequence: string[];
  userDataPath: string;
  failWarmUp: { value: boolean };
  /** With `holdWarmUp`, every warm-up blocks until `release()`. */
  warmUpGate: { started: Promise<void>; release: () => void };
  /** With `holdSetProxy`, every `setProxy` blocks until `release()`. */
  setProxyGate: { started: Promise<void>; release: () => void };
  /** Every proxy started, in order. */
  proxies: Array<{ port: number }>;
}

const ROUTE_SETUP_SEQUENCE = [
  "proxy.listening",
  "session.created",
  "session.proxied",
  "credential.warmed",
  "route.ready",
];
const PARKED_SETUP_SEQUENCE = ["proxy.listening", "session.created", "session.proxied"];

const directories = new Set<string>();
const managers = new Set<BrowserRoutingManager>();

afterEach(async () => {
  for (const manager of managers) {
    await manager.shutdown();
  }
  managers.clear();
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

async function createHarness(
  options: { userDataPath?: string; holdWarmUp?: boolean; holdSetProxy?: boolean } = {},
): Promise<Harness> {
  const userDataPath =
    options.userDataPath ?? (await mkdtemp(path.join(os.tmpdir(), "paseo-browser-routing-")));
  directories.add(userDataPath);
  const sessions = new Map<string, FakeSession>();
  const warmUps: Harness["warmUps"] = [];
  const events: Harness["events"] = [];
  const sequence: string[] = [];
  const failWarmUp = { value: false };
  const warmUpStarted = deferred();
  const warmUpReleased = deferred();
  const setProxyGate = {
    started: deferred(),
    released: options.holdSetProxy ? deferred() : null,
  };
  const proxies: Harness["proxies"] = [];
  const manager = new BrowserRoutingManager({
    settings: createDesktopSettingsStore({ userDataPath }),
    sessions: {
      fromPartition: (partition) => {
        let session = sessions.get(partition);
        if (!session) {
          session = new FakeSession(partition, sequence, setProxyGate);
          sessions.set(partition, session);
        }
        sequence.push("session.created");
        return session;
      },
    },
    warmUp: async ({ session, credential }) => {
      warmUpStarted.resolve();
      if (options.holdWarmUp) await warmUpReleased.promise;
      if (failWarmUp.value) throw new Error("warm-up failed");
      warmUps.push({ session: session as FakeSession, credential });
      sequence.push("credential.warmed");
    },
    startProxy: async (proxyOptions) => {
      const proxy = await startLocalBrowserProxy(proxyOptions);
      proxies.push(proxy);
      sequence.push((await isPortOpen(proxy.port)) ? "proxy.listening" : "proxy.not-listening");
      return proxy;
    },
    log: (_level, event) => {
      if (event === "route.ready") sequence.push("route.ready");
    },
    emit: (senderId, event, payload) => {
      events.push({ senderId, event, payload });
      return true;
    },
    broadcast: (event, payload) => {
      events.push({ senderId: "broadcast", event, payload });
    },
  });
  managers.add(manager);
  return {
    manager,
    sessions,
    warmUps,
    events,
    sequence,
    userDataPath,
    failWarmUp,
    warmUpGate: { started: warmUpStarted.promise, release: warmUpReleased.resolve },
    setProxyGate: {
      started: setProxyGate.started.promise,
      release: () => setProxyGate.released?.resolve(),
    },
    proxies,
  };
}

function proxyPortOf(session: FakeSession): number {
  return Number(/:(\d+)$/.exec(session.proxyConfigs.at(-1)?.proxyRules ?? "")?.[1]);
}

/** A plain HTTP request through the proxy, authenticated like Chromium would be. */
function requestThroughProxy(manager: BrowserRoutingManager, port: number): Promise<number> {
  const credential = manager.resolveProxyCredential({
    isProxy: true,
    scheme: "basic",
    host: "127.0.0.1",
    port,
    realm: "Paseo",
  });
  if (!credential) throw new Error(`no credential for proxy port ${port}`);
  const authorization = Buffer.from(`${credential.username}:${credential.password}`).toString(
    "base64",
  );
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "http://intranet.invalid/",
        headers: { Host: "intranet.invalid", "Proxy-Authorization": `Basic ${authorization}` },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Resolves to whether `promise` settled before the next macrotask. */
async function settledBeforeNextTurn(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("BrowserRoutingManager", () => {
  test("derives a per-host partition that never matches a legacy tab profile", () => {
    const partition = browserRoutingPartitionForServer("server-a");
    expect(partition).toMatch(/^persist:paseo-browser-via-[0-9a-f]{16}$/);
    expect(partition).toBe(browserRoutingPartitionForServer("server-a"));
    expect(partition).not.toBe(browserRoutingPartitionForServer("server-b"));
  });

  test("reports routing off and refuses a partition until the host is enabled", async () => {
    const { manager, sessions } = await createHarness();

    expect(await manager.isEnabled("server-a")).toBe(false);
    expect(await manager.resolvePartition("server-a")).toEqual({
      ok: false,
      error: { code: "routing_disabled", message: expect.any(String) },
    });
    expect(sessions.size).toBe(0);
  });

  test("enabling a host starts its proxy, configures the session, and warms the credential before answering", async () => {
    const { manager, sessions, warmUps, events, userDataPath } = await createHarness();

    const result = await manager.setEnabled("server-a", true);

    expect(result).toEqual({ ok: true });
    const partition = browserRoutingPartitionForServer("server-a");
    expect([...sessions.keys()]).toEqual([partition]);
    const session = sessions.get(partition);
    expect(session!.proxyConfigs).toHaveLength(1);
    const port = Number(
      /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(session!.proxyConfigs[0].proxyRules)?.[1],
    );
    expect(port).toBeGreaterThan(0);
    expect(session!.proxyConfigs[0].proxyBypassRules).toBe("<-loopback>");
    expect(await isPortOpen(port)).toBe(true);
    expect(warmUps).toEqual([
      { session, credential: expect.objectContaining({ username: expect.any(String) }) },
    ]);
    expect(events).toEqual([
      {
        senderId: "broadcast",
        event: BROWSER_ROUTING_CHANGED_EVENT,
        payload: { serverId: "server-a", enabled: true },
      },
    ]);

    expect(await manager.resolvePartition("server-a")).toEqual({ ok: true, partition });
    expect(manager.isReadyRoutedPartition(partition)).toBe(true);
    expect(manager.isReadyRoutedSession(session!)).toBe(true);
    expect(manager.isReadyRoutedPartition("persist:paseo-browser-via-0000000000000000")).toBe(
      false,
    );
    const authInfo = { isProxy: true, scheme: "basic", host: "127.0.0.1", port, realm: "Paseo" };
    expect(manager.resolveProxyCredential(authInfo)).toEqual(warmUps[0].credential);
    expect(manager.resolveProxyCredential({ ...authInfo, isProxy: false })).toBeNull();
    expect(manager.resolveProxyCredential({ ...authInfo, host: "localhost" })).toBeNull();
    expect(manager.resolveProxyCredential({ ...authInfo, port: port + 1 })).toBeNull();
    expect(manager.resolveProxyCredential({ ...authInfo, scheme: "digest" })).toBeNull();
    expect(manager.resolveProxyCredential({ ...authInfo, realm: "Other" })).toBeNull();

    const persisted = JSON.parse(
      await readFile(path.join(userDataPath, "desktop-settings.json"), "utf8"),
    );
    expect(persisted.browserRouting).toEqual({ "server-a": { enabled: true, partition } });
    expect(persisted.settings.browserRouting).toBeUndefined();
  });

  test("creates the session only once its proxy listens and points it there before the warm-up", async () => {
    const first = await createHarness();

    await first.manager.setEnabled("server-a", true);
    expect(first.sequence).toEqual(ROUTE_SETUP_SEQUENCE);

    // "Clear browser data": the session and proxy survive; only the credential is redone.
    first.sequence.length = 0;
    await first.manager.rewarmCredentials();
    expect(first.sequence).toEqual(["session.proxied", "credential.warmed", "route.ready"]);
    await first.manager.shutdown();
    managers.delete(first.manager);

    // App restart with the host already enabled.
    const second = await createHarness({ userDataPath: first.userDataPath });
    await second.manager.initialize();
    expect(second.sequence).toEqual(ROUTE_SETUP_SEQUENCE);
  });

  test("a failed warm-up leaves the host disabled rather than half-routed", async () => {
    const { manager, failWarmUp, events, sessions } = await createHarness();
    failWarmUp.value = true;

    const result = await manager.setEnabled("server-a", true);

    expect(result).toEqual({
      ok: false,
      error: { code: "setup_failed", message: expect.any(String) },
    });
    expect(await manager.isEnabled("server-a")).toBe(false);
    expect(manager.isReadyRoutedPartition(browserRoutingPartitionForServer("server-a"))).toBe(
      false,
    );
    expect(events).toEqual([]);
    // The session already exists: it stays behind the proxy, which now denies everything.
    const session = sessions.get(browserRoutingPartitionForServer("server-a"))!;
    expect(await requestThroughProxy(manager, proxyPortOf(session))).toBe(503);
  });

  test("disabling closes the provider and leaves the session behind a proxy that denies everything", async () => {
    const { manager, sessions, events } = await createHarness();
    await manager.setEnabled("server-a", true);
    const partition = browserRoutingPartitionForServer("server-a");
    const port = proxyPortOf(sessions.get(partition)!);
    const registration = manager.bridge.register(1, {
      serverId: "server-a",
      subscriptionId: "sub",
      initialWindowBytes: 1024,
      maxDataBytes: 256,
      maxStreams: 4,
      connectTimeoutMs: 1000,
    });
    expect(registration.ok).toBe(true);

    expect(await manager.setEnabled("server-a", false)).toEqual({ ok: true });

    expect(manager.bridge.hasProvider("server-a")).toBe(false);
    expect(await isPortOpen(port)).toBe(true);
    expect(manager.isReadyRoutedPartition(partition)).toBe(false);
    expect(await manager.resolvePartition("server-a")).toEqual({
      ok: false,
      error: { code: "routing_disabled", message: expect.any(String) },
    });
    // Even a provider registered for the disabled host never gets a stream.
    expect(
      manager.bridge.register(1, {
        serverId: "server-a",
        subscriptionId: "sub-2",
        initialWindowBytes: 1024,
        maxDataBytes: 256,
        maxStreams: 4,
        connectTimeoutMs: 1000,
      }).ok,
    ).toBe(true);
    expect(await requestThroughProxy(manager, port)).toBe(503);
    expect(events.some((event) => event.event === "network_tunnel_stream_open")).toBe(false);
    expect(await manager.listPersistedSessions()).toEqual([sessions.get(partition)]);
    expect(sessions.get(partition)!.proxyConfigs).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      senderId: "broadcast",
      event: BROWSER_ROUTING_CHANGED_EVENT,
      payload: { serverId: "server-a", enabled: false },
    });
    expect(events.some((event) => event.event === "network_tunnel_provider_closed")).toBe(true);
  });

  test("initialize brings persisted hosts back up with a fresh credential", async () => {
    const first = await createHarness();
    await first.manager.setEnabled("server-a", true);
    await first.manager.setEnabled("server-b", true);
    await first.manager.setEnabled("server-b", false);
    const firstCredential = first.warmUps[0].credential;
    await first.manager.shutdown();
    managers.delete(first.manager);

    const second = await createHarness({ userDataPath: first.userDataPath });
    await second.manager.initialize();

    const partition = browserRoutingPartitionForServer("server-a");
    expect(second.manager.isReadyRoutedPartition(partition)).toBe(true);
    expect(
      second.manager.isReadyRoutedPartition(browserRoutingPartitionForServer("server-b")),
    ).toBe(false);
    expect(second.warmUps).toHaveLength(1);
    expect(second.warmUps[0].credential).not.toEqual(firstCredential);
    expect([...second.sessions.keys()]).toEqual([partition]);
  });

  test("clearing data after a restart prepares a disabled host's session behind a denying proxy", async () => {
    const first = await createHarness();
    await first.manager.setEnabled("server-a", true);
    await first.manager.setEnabled("server-b", true);
    await first.manager.setEnabled("server-b", false);
    await first.manager.shutdown();
    managers.delete(first.manager);
    const partitionA = browserRoutingPartitionForServer("server-a");
    const partitionB = browserRoutingPartitionForServer("server-b");

    const second = await createHarness({ userDataPath: first.userDataPath });
    await second.manager.initialize();
    expect([...second.sessions.keys()]).toEqual([partitionA]);
    expect(second.sequence).toEqual(ROUTE_SETUP_SEQUENCE);

    const listed = await second.manager.listPersistedSessions();

    expect(listed).toEqual([second.sessions.get(partitionA), second.sessions.get(partitionB)]);
    expect(second.sequence).toEqual([...ROUTE_SETUP_SEQUENCE, ...PARKED_SETUP_SEQUENCE]);
    const sessionB = second.sessions.get(partitionB)!;
    expect(sessionB.proxyConfigs).toEqual([
      {
        proxyRules: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
        proxyBypassRules: "<-loopback>",
      },
    ]);
    const portB = proxyPortOf(sessionB);
    expect(await isPortOpen(portB)).toBe(true);
    expect(await requestThroughProxy(second.manager, portB)).toBe(503);
    expect(second.manager.isReadyRoutedPartition(partitionB)).toBe(false);
    expect(second.warmUps).toHaveLength(1);

    // Listing again changes nothing; enabling the host reuses its proxy and session.
    second.sequence.length = 0;
    expect(await second.manager.listPersistedSessions()).toEqual(listed);
    expect(second.sequence).toEqual([]);
    expect(await second.manager.setEnabled("server-b", true)).toEqual({ ok: true });
    expect(second.sequence).toEqual(["session.proxied", "credential.warmed", "route.ready"]);
    expect(proxyPortOf(sessionB)).toBe(portB);
    expect(second.manager.isReadyRoutedPartition(partitionB)).toBe(true);
  });

  test("clearing data during startup waits for the setup in progress instead of touching the session", async () => {
    const first = await createHarness();
    await first.manager.setEnabled("server-a", true);
    await first.manager.shutdown();
    managers.delete(first.manager);
    const partition = browserRoutingPartitionForServer("server-a");

    const second = await createHarness({ userDataPath: first.userDataPath, holdWarmUp: true });
    const initialized = second.manager.initialize();
    await second.warmUpGate.started;
    expect(second.sequence).toEqual(["proxy.listening", "session.created", "session.proxied"]);

    const listing = second.manager.listPersistedSessions();
    expect(await settledBeforeNextTurn(listing)).toBe(false);
    expect(second.sequence).toEqual(["proxy.listening", "session.created", "session.proxied"]);

    second.warmUpGate.release();
    await initialized;
    expect(await listing).toEqual([second.sessions.get(partition)]);
    expect(second.sequence).toEqual(ROUTE_SETUP_SEQUENCE);
    expect(second.sessions.get(partition)!.proxyConfigs).toHaveLength(1);
    expect(second.manager.isReadyRoutedPartition(partition)).toBe(true);
  });

  test("rewarms every ready route after the auth cache is cleared", async () => {
    const { manager, warmUps } = await createHarness();
    await manager.setEnabled("server-a", true);
    await manager.setEnabled("server-b", true);

    await manager.rewarmCredentials();

    expect(warmUps).toHaveLength(4);
    expect(warmUps[2].credential).toEqual(warmUps[0].credential);
    expect(manager.isReadyRoutedPartition(browserRoutingPartitionForServer("server-a"))).toBe(true);
  });

  test("a failed rewarm drops readiness, rejects, and recovers on the next successful warm-up", async () => {
    const { manager, warmUps, failWarmUp } = await createHarness();
    await manager.setEnabled("server-a", true);
    const partition = browserRoutingPartitionForServer("server-a");

    failWarmUp.value = true;
    await expect(manager.rewarmCredentials()).rejects.toThrow(/warm-up failed/);
    expect(manager.isReadyRoutedPartition(partition)).toBe(false);
    expect(await manager.resolvePartition("server-a")).toEqual({
      ok: false,
      error: { code: "not_ready", message: expect.any(String) },
    });

    failWarmUp.value = false;
    expect(await manager.resolvePartition("server-a")).toEqual({ ok: true, partition });
    expect(manager.isReadyRoutedPartition(partition)).toBe(true);
    expect(warmUps).toHaveLength(2);
  });

  test("answers a proxy login once per request and cancels a repeated challenge", async () => {
    const { manager, sessions } = await createHarness();
    await manager.setEnabled("server-a", true);
    const partition = browserRoutingPartitionForServer("server-a");
    const port = Number(/:(\d+)$/.exec(sessions.get(partition)!.proxyConfigs[0].proxyRules)?.[1]);
    const authInfo = { isProxy: true, scheme: "basic", host: "127.0.0.1", port, realm: "Paseo" };
    const request = { authInfo, requestKey: "7|http://intranet.invalid/" };

    expect(manager.decideProxyLogin(request, 1_000)).toMatchObject({ kind: "answer" });
    expect(manager.decideProxyLogin(request, 1_100)).toEqual({ kind: "cancel" });
    expect(manager.decideProxyLogin(request, 1_200)).toMatchObject({ kind: "answer" });
    expect(
      manager.decideProxyLogin({ authInfo, requestKey: "8|http://intranet.invalid/" }, 1_300),
    ).toMatchObject({ kind: "answer" });
    expect(manager.decideProxyLogin(request, 20_000)).toMatchObject({ kind: "answer" });
    expect(
      manager.decideProxyLogin({ authInfo: { ...authInfo, realm: "Other" }, requestKey: "x" }),
    ).toEqual({ kind: "ignore" });
  });

  test("shutting down during a clear-data setup stops it and opens no further proxy", async () => {
    const first = await createHarness();
    await first.manager.setEnabled("server-a", true);
    await first.manager.setEnabled("server-a", false);
    await first.manager.setEnabled("server-b", true);
    await first.manager.setEnabled("server-b", false);
    await first.manager.shutdown();
    managers.delete(first.manager);

    const second = await createHarness({ userDataPath: first.userDataPath, holdSetProxy: true });
    const listing = second.manager.listPersistedSessions();
    await second.setProxyGate.started;
    expect(second.proxies).toHaveLength(1);

    const closing = second.manager.shutdown();
    expect(await settledBeforeNextTurn(closing)).toBe(false);
    second.setProxyGate.release();
    await closing;
    await expect(listing).rejects.toThrow(/shut down/);

    expect(second.proxies).toHaveLength(1);
    expect(await isPortOpen(second.proxies[0].port)).toBe(false);
    expect(second.sequence).toEqual(["proxy.listening", "session.created", "session.proxied"]);
    expect([...second.sessions.keys()]).toEqual([browserRoutingPartitionForServer("server-a")]);
    expect(
      second.manager.isReadyRoutedPartition(browserRoutingPartitionForServer("server-a")),
    ).toBe(false);
    await expect(second.manager.listPersistedSessions()).rejects.toThrow(/shut down/);
  });

  test("shutting down during a warm-up never publishes readiness and closes the proxy", async () => {
    const first = await createHarness();
    await first.manager.setEnabled("server-a", true);
    await first.manager.shutdown();
    managers.delete(first.manager);

    const second = await createHarness({ userDataPath: first.userDataPath, holdWarmUp: true });
    const initialized = second.manager.initialize();
    await second.warmUpGate.started;

    const closing = second.manager.shutdown();
    expect(await settledBeforeNextTurn(closing)).toBe(false);
    second.warmUpGate.release();
    await closing;
    await initialized;

    const partition = browserRoutingPartitionForServer("server-a");
    expect(second.sequence).toEqual([
      "proxy.listening",
      "session.created",
      "session.proxied",
      "credential.warmed",
    ]);
    expect(second.manager.isReadyRoutedPartition(partition)).toBe(false);
    expect(second.proxies).toHaveLength(1);
    expect(await isPortOpen(second.proxies[0].port)).toBe(false);
    expect(await second.manager.resolvePartition("server-a")).toEqual({
      ok: false,
      error: { code: "not_ready", message: expect.any(String) },
    });
    expect(second.proxies).toHaveLength(1);
    expect(await second.manager.isEnabled("server-a")).toBe(true);
  });

  test("a renderer going away closes its providers and their streams", async () => {
    const { manager, events } = await createHarness();
    await manager.setEnabled("server-a", true);
    const registration = manager.bridge.register(9, {
      serverId: "server-a",
      subscriptionId: "sub",
      initialWindowBytes: 1024,
      maxDataBytes: 256,
      maxStreams: 4,
      connectTimeoutMs: 1000,
    });
    const closeReasons: number[] = [];
    manager.bridge.openStreamFor(
      "server-a",
      { host: "intranet.invalid", port: 80 },
      { onConnected: () => {}, onData: () => {}, onClose: (reason) => closeReasons.push(reason) },
    );
    const eventCount = events.length;

    manager.handleRendererGone(9);

    expect(closeReasons).toEqual([TunnelCloseReason.NetworkUnreachable]);
    expect(manager.bridge.hasProvider("server-a")).toBe(false);
    expect(registration.ok).toBe(true);
    expect(events).toHaveLength(eventCount);
  });
});
