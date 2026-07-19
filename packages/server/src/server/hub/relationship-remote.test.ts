import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { HubExecutionAgents } from "./daemon-executions.js";
import {
  HubRelationshipController,
  type HubRelationshipClock,
  type HubRelationshipRetryPolicy,
  type ScheduledRelationshipTask,
} from "./relationship-controller.js";
import {
  DirectHubRelationshipRemote,
  HubEnrollmentRejectedError,
  type HubSocketConnection,
  type HubSocketEvents,
} from "./relationship-remote.js";

const openServers: ReturnType<typeof createServer>[] = [];
const openUpgradeHubs: UpgradeRejectingHub[] = [];
const openPaseoHomes: string[] = [];

afterEach(async () => {
  for (const hub of openUpgradeHubs.splice(0)) hub.destroyConnections();
  await Promise.all(openServers.splice(0).map((server) => closeServer(server)));
  await Promise.all(openPaseoHomes.splice(0).map((home) => rm(home, { recursive: true })));
});

test.each([401, 403, 404])(
  "revocation status %s clears already-invalid local authority",
  async (status) => {
    const hubOrigin = await startHubReturning(status);
    const remote = new DirectHubRelationshipRemote();

    await expect(
      remote.revoke({ daemonId: "daemon-1", hubOrigin, credential: "invalid" }),
    ).resolves.toBeUndefined();
  },
);

test("transient revocation failures remain retryable", async () => {
  const hubOrigin = await startHubReturning(503);
  const remote = new DirectHubRelationshipRemote();

  await expect(
    remote.revoke({ daemonId: "daemon-1", hubOrigin, credential: "credential" }),
  ).rejects.toThrow("Hub revocation failed (503)");
});

test.each([408, 429])("transient enrollment status %s remains retryable", async (status) => {
  const hubOrigin = await startHubReturning(status);
  const remote = new DirectHubRelationshipRemote();

  const error = await remote
    .enroll({
      daemonId: "daemon-1",
      idempotencyKey: "ceremony-1",
      hubOrigin,
      token: "token",
      serverId: "server-1",
      daemonPublicKey: "public-key",
      credentialVerifier: "verifier",
      scopes: ["hub.execution.*"],
    })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(HubEnrollmentRejectedError);
  expect((error as Error).message).toBe(`Hub enrollment failed (${status})`);
});

test("enrollment rejects a transport URL that cannot open a WebSocket", async () => {
  const hubOrigin = await startEnrollmentHub("ftp://hub.test/daemon");
  const remote = new DirectHubRelationshipRemote();

  await expect(
    remote.enroll({
      daemonId: "daemon-1",
      idempotencyKey: "ceremony-1",
      hubOrigin,
      token: "token",
      serverId: "server-1",
      daemonPublicKey: "public-key",
      credentialVerifier: "verifier",
      scopes: ["hub.execution.*"],
    }),
  ).rejects.toThrow("Hub WebSocket URL must use ws or wss");
});

test("enrollment rejects a WebSocket URL with a fragment", async () => {
  const hubOrigin = await startEnrollmentHub("ws://hub.test/daemon#fragment");
  const remote = new DirectHubRelationshipRemote();

  await expect(
    remote.enroll({
      daemonId: "daemon-1",
      idempotencyKey: "ceremony-1",
      hubOrigin,
      token: "token",
      serverId: "server-1",
      daemonPublicKey: "public-key",
      credentialVerifier: "verifier",
      scopes: ["hub.execution.*"],
    }),
  ).rejects.toThrow("Hub WebSocket URL cannot include a fragment");
});

test("enrollment rejects a WebSocket outside the enrolled Hub authority", async () => {
  const hubOrigin = await startEnrollmentHub("ws://other-hub.test/daemon");
  const remote = new DirectHubRelationshipRemote();

  await expect(
    remote.enroll({
      daemonId: "daemon-1",
      idempotencyKey: "ceremony-1",
      hubOrigin,
      token: "token",
      serverId: "server-1",
      daemonPublicKey: "public-key",
      credentialVerifier: "verifier",
      scopes: ["hub.execution.*"],
    }),
  ).rejects.toThrow("Hub WebSocket URL must match the Hub origin");
});

test.each(["enrollment", "revocation"])("%s HTTP calls are bounded", async (operation) => {
  const hubOrigin = await startStalledHub();
  const remote = new DirectHubRelationshipRemote({ requestTimeoutMs: 25 });

  const request =
    operation === "enrollment"
      ? remote.enroll({
          daemonId: "daemon-1",
          idempotencyKey: "ceremony-1",
          hubOrigin,
          token: "token",
          serverId: "server-1",
          daemonPublicKey: "public-key",
          credentialVerifier: "verifier",
          scopes: ["hub.execution.*"],
        })
      : remote.revoke({
          daemonId: "daemon-1",
          hubOrigin,
          credential: "credential",
        });

  await expect(request).rejects.toThrow("Hub request timed out");
});

test.each([401, 403] as const)(
  "socket authentication status %s is terminal and releases the failed upgrade",
  async (status) => {
    const hub = await UpgradeRejectingHub.start([status]);
    const outcomes = new SocketOutcomes();
    const remote = new DirectHubRelationshipRemote();

    const socket = remote.openSocket(
      {
        daemonId: "daemon-1",
        webSocketUrl: hub.webSocketUrl,
        credential: "invalid",
      },
      outcomes.events,
    ) as HubSocketConnection & WebSocket;

    expect(await outcomes.next()).toEqual({ type: "rejected", status });
    await hub.expectAttemptReleased(1);
    expect(await outcomes.afterCleanup()).toEqual([{ type: "rejected", status }]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(hub.openConnections()).toBe(0);
  },
);

test("a transient socket response releases the failed upgrade and reports one connection loss", async () => {
  const hub = await UpgradeRejectingHub.start([503]);
  const outcomes = new SocketOutcomes();
  const remote = new DirectHubRelationshipRemote();

  const socket = remote.openSocket(
    {
      daemonId: "daemon-1",
      webSocketUrl: hub.webSocketUrl,
      credential: "credential",
    },
    outcomes.events,
  ) as HubSocketConnection & WebSocket;

  expect(await outcomes.next()).toEqual({ type: "closed", code: 1006 });
  await hub.expectAttemptReleased(1);
  expect(await outcomes.afterCleanup()).toEqual([{ type: "closed", code: 1006 }]);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  expect(hub.openConnections()).toBe(0);
});

test("a stalled socket opening handshake times out and releases the connection", async () => {
  const hub = await UpgradeRejectingHub.start(["stall"]);
  const outcomes = new SocketOutcomes();
  const remote = new DirectHubRelationshipRemote({ requestTimeoutMs: 25 });

  const socket = remote.openSocket(
    {
      daemonId: "daemon-1",
      webSocketUrl: hub.webSocketUrl,
      credential: "credential",
    },
    outcomes.events,
  ) as HubSocketConnection & WebSocket;

  expect(await outcomes.next()).toEqual({
    type: "failed",
    message: "Opening handshake has timed out",
  });
  expect(await outcomes.afterCleanup()).toEqual([
    { type: "failed", message: "Opening handshake has timed out" },
  ]);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

test.each([401, 403] as const)(
  "controller treats socket authentication status %s as terminal without redialing",
  async (status) => {
    const hub = await UpgradeRejectingHub.start([status]);
    const clock = new ManualRelationshipClock();
    const controller = await connectController(hub, clock);

    await hub.expectAttemptReleased(1);

    expect(controller.status()).toMatchObject({
      state: "revoked",
      lastError: `Hub rejected socket authentication (${status})`,
    });
    expect(hub.attemptCount()).toBe(1);
    expect(clock.pendingTasks()).toBe(0);
    expect(hub.openConnections()).toBe(0);
  },
);

test("controller redials after a transient socket response and releases both failed upgrades", async () => {
  const hub = await UpgradeRejectingHub.start([503, 401]);
  const clock = new ManualRelationshipClock();
  const controller = await connectController(hub, clock);

  await hub.expectAttemptReleased(1);
  expect(controller.status().state).toBe("reconnecting");
  expect(clock.pendingTasks()).toBe(1);

  clock.runNext();
  await hub.expectAttemptReleased(2);

  expect(hub.attemptCount()).toBe(2);
  expect(controller.status().state).toBe("revoked");
  expect(clock.pendingTasks()).toBe(0);
  expect(hub.openConnections()).toBe(0);
});

test("controller redials once after a failed upgrade without also handling its close", async () => {
  const hub = await UpgradeRejectingHub.start([0, 401]);
  const clock = new ManualRelationshipClock();
  const controller = await connectController(hub, clock);

  await hub.expectAttemptReleased(1);

  expect(controller.status().state).toBe("reconnecting");
  expect(clock.scheduledAttempts()).toEqual([0]);
  expect(clock.pendingTasks()).toBe(1);

  clock.runNext();
  await hub.expectAttemptReleased(2);

  expect(hub.attemptCount()).toBe(2);
  expect(controller.status().state).toBe("revoked");
  expect(clock.pendingTasks()).toBe(0);
});

async function startHubReturning(status: number): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status).end();
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function startEnrollmentHub(webSocketUrl: string): Promise<string> {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const enrollment = JSON.parse(body) as { daemonId: string };
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        daemonId: enrollment.daemonId,
        scopes: ["hub.execution.*"],
        webSocketUrl,
      }),
    );
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function startStalledHub(): Promise<string> {
  const server = createServer(() => undefined);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

type SocketOutcome =
  | { type: "connected" }
  | { type: "rejected"; status: 401 | 403 }
  | { type: "closed"; code: number }
  | { type: "failed"; message: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class SocketOutcomes {
  private readonly outcomes: SocketOutcome[] = [];
  private nextOutcome = deferred<SocketOutcome>();

  readonly events: HubSocketEvents = {
    connected: () => this.record({ type: "connected" }),
    rejected: (status) => this.record({ type: "rejected", status }),
    closed: (code) => this.record({ type: "closed", code }),
    failed: (error) => this.record({ type: "failed", message: error.message }),
  };

  next(): Promise<SocketOutcome> {
    return withDeadline(this.nextOutcome.promise, "Hub socket produced no outcome");
  }

  async afterCleanup(): Promise<SocketOutcome[]> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return this.outcomes.slice();
  }

  private record(outcome: SocketOutcome): void {
    this.outcomes.push(outcome);
    this.nextOutcome.resolve(outcome);
    this.nextOutcome = deferred<SocketOutcome>();
  }
}

class UpgradeRejectingHub {
  private readonly server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const enrollment = JSON.parse(body) as { daemonId: string };
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        daemonId: enrollment.daemonId,
        scopes: ["hub.execution.*"],
        webSocketUrl: this.webSocketUrl,
      }),
    );
  });
  private readonly sockets = new Set<Socket>();
  private readonly releasedAttempts = new Map<number, Deferred<void>>();
  private attemptObserved = deferred<void>();
  private attempts = 0;

  private constructor(private readonly statuses: Array<number | "stall">) {
    this.server.on("upgrade", (_request, socket) => {
      const attempt = ++this.attempts;
      this.attemptObserved.resolve();
      this.attemptObserved = deferred<void>();
      const released = deferred<void>();
      this.releasedAttempts.set(attempt, released);
      this.sockets.add(socket);
      socket.once("close", () => {
        this.sockets.delete(socket);
        released.resolve();
      });
      const status = this.statuses[attempt - 1] ?? this.statuses.at(-1) ?? 503;
      if (status === "stall") {
        socket.resume();
        return;
      }
      if (status === 0) {
        socket.destroy();
        return;
      }
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndeny`,
      );
    });
  }

  static async start(statuses: Array<number | "stall">): Promise<UpgradeRejectingHub> {
    const hub = new UpgradeRejectingHub(statuses);
    openUpgradeHubs.push(hub);
    openServers.push(hub.server);
    await new Promise<void>((resolve, reject) => {
      hub.server.once("error", reject);
      hub.server.listen(0, "127.0.0.1", resolve);
    });
    return hub;
  }

  get webSocketUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}/daemon`;
  }

  get origin(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  attemptCount(): number {
    return this.attempts;
  }

  openConnections(): number {
    return this.sockets.size;
  }

  destroyConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async expectAttemptReleased(attempt: number): Promise<void> {
    while (this.attempts < attempt) {
      await withDeadline(
        this.attemptObserved.promise,
        `Hub did not receive socket attempt ${attempt}`,
      );
    }
    const released = this.releasedAttempts.get(attempt);
    if (!released) throw new Error(`Hub did not receive socket attempt ${attempt}`);
    await withDeadline(released.promise, `Hub socket attempt ${attempt} remained open`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class ManualRelationshipClock implements HubRelationshipClock, HubRelationshipRetryPolicy {
  private readonly tasks: Array<{ cancelled: boolean; task: () => void }> = [];
  private readonly attempts: number[] = [];

  now(): Date {
    return new Date("2026-07-13T00:00:00.000Z");
  }

  delay(attempt: number): number {
    this.attempts.push(attempt);
    return 0;
  }

  schedule(_delayMs: number, task: () => void): ScheduledRelationshipTask {
    const scheduled = { cancelled: false, task };
    this.tasks.push(scheduled);
    return { cancel: () => (scheduled.cancelled = true) };
  }

  pendingTasks(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }

  scheduledAttempts(): number[] {
    return this.attempts.slice();
  }

  runNext(): void {
    const scheduled = this.tasks.shift();
    if (!scheduled || scheduled.cancelled) throw new Error("No Hub reconnect is scheduled");
    scheduled.task();
  }
}

const unusedExecutionAgents: HubExecutionAgents = {
  create: async () => {
    throw new Error("Unexpected Hub agent create");
  },
  subscribe: () => () => undefined,
  invalidateAuthority: async () => undefined,
};

async function connectController(
  hub: UpgradeRejectingHub,
  clock: ManualRelationshipClock,
): Promise<HubRelationshipController> {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-hub-socket-"));
  openPaseoHomes.push(paseoHome);
  const controller = new HubRelationshipController({
    paseoHome,
    serverId: "server-1",
    daemonPublicKey: "daemon-public-key",
    logger: pino({ level: "silent" }),
    remote: new DirectHubRelationshipRemote(),
    clock,
    retryPolicy: clock,
    attachSocket: async () => undefined,
    createExecutionAgents: () => unusedExecutionAgents,
  });
  await controller.connect({ hubUrl: hub.origin, token: "enrollment-token" });
  return controller;
}

async function withDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
