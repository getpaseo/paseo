import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { render } from "../../output/index.js";
import { runHubConnect } from "./connect.js";
import type { HubCredentialStore, StoredHubCredential } from "./credentials.js";
import type { HubDaemonClient, HubDaemonConnection, HubStatus } from "./daemon-client.js";
import { runHubDisconnect } from "./disconnect.js";
import { runHubLogin } from "./login.js";
import { runHubLogout } from "./logout.js";
import { runHubProjects } from "./projects.js";
import { createHubCommand } from "./index.js";
import type { HubReporter } from "./reporter.js";

const quietReporter: HubReporter = { progress() {} };

describe("Hub commands", () => {
  it("exposes the hard-cut Hub command surface without connect --token", () => {
    const command = createHubCommand();
    const names = command.commands.map((child) => child.name());
    const connect = command.commands.find((child) => child.name() === "connect");

    assert.deepEqual(names, [
      "login",
      "connect",
      "status",
      "disconnect",
      "projects",
      "deploy",
      "logout",
    ]);
    assert.match(connect?.helpInformation() ?? "", /--api-key <secret>/u);
    assert.doesNotMatch(connect?.helpInformation() ?? "", /--token/u);
    assert.match(connect?.helpInformation() ?? "", /\[origin\]/u);
    let help = "";
    connect?.configureOutput({
      writeOut(value) {
        help += value;
      },
    });
    connect?.outputHelp();
    assert.match(help, /active stored login.*https:\/\/hub\.paseo\.sh/u);
  });

  it("login stores the durable credential and marks its normalized origin active", async () => {
    const credentials = new MemoryCredentials();

    const result = await runHubLogin(
      "https://hub.test:443",
      {},
      {
        env: {},
        credentials,
        flow: { authorize: async () => "paseo_cli_prefix_durable-secret" },
        reporter: quietReporter,
      },
    );

    assert.deepEqual(credentials.active(), {
      origin: "https://hub.test",
      credential: "paseo_cli_prefix_durable-secret",
    });
    assert.deepEqual(result.data, { origin: "https://hub.test", status: "logged_in" });
    assert.equal(JSON.stringify(result).includes("durable-secret"), false);
  });

  it("login without an origin uses the hosted default and reports it before authorization", async () => {
    const credentials = new MemoryCredentials();
    const events: string[] = [];

    const result = await runHubLogin(
      undefined,
      {},
      {
        env: {},
        credentials,
        flow: {
          authorize: async (origin) => {
            events.push(`authorize:${origin}`);
            return "paseo_cli_prefix_durable-secret";
          },
        },
        reporter: { progress: (message) => events.push(`progress:${message}`) },
      },
    );

    assert.deepEqual(events, [
      "progress:Logging in to https://hub.paseo.sh",
      "authorize:https://hub.paseo.sh",
    ]);
    assert.equal(result.data.origin, "https://hub.paseo.sh");
  });

  it("connect exchanges authority once and gives only the enrollment token to the daemon", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "stored-human-secret" });
    const daemon = new FakeDaemon("https://hub.test");
    const observed: Array<{ origin: string; credential: string }> = [];
    const progress: string[] = [];

    await runHubConnect(
      "https://hub.test",
      {},
      {
        env: {},
        credentials,
        hub: {
          issueEnrollmentToken: async (origin, credential) => {
            observed.push({ origin, credential });
            return "one-time-enrollment-token-with-enough-length";
          },
        },
        daemon: new FakeDaemonConnection(daemon),
        reporter: { progress: (message) => progress.push(message) },
      },
    );

    assert.deepEqual(observed, [{ origin: "https://hub.test", credential: "stored-human-secret" }]);
    assert.deepEqual(daemon.connections, [
      { origin: "https://hub.test", token: "one-time-enrollment-token-with-enough-length" },
    ]);
    assert.equal(daemon.connections[0]?.token.includes("stored-human-secret"), false);
    assert.deepEqual(progress, ["Connecting this daemon to https://hub.test"]);
  });

  it("projects reports its normalized destination before listing", async () => {
    const credentials = new MemoryCredentials();
    const events: string[] = [];

    const result = await runHubProjects(
      { hub: "https://hub.test:443", apiKey: "explicit-secret" },
      {
        env: {},
        credentials,
        hub: {
          listProjects: async (origin) => {
            events.push(`request:${origin}`);
            return [];
          },
        },
        reporter: { progress: (message) => events.push(`progress:${message}`) },
      },
    );

    assert.deepEqual(events, [
      "progress:Listing projects from https://hub.test",
      "request:https://hub.test",
    ]);
    assert.deepEqual(JSON.parse(render(result, { format: "json" })), {
      origin: "https://hub.test",
      projects: [],
    });
  });

  it("connect without an origin uses the active login", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://active.test", credential: "active-secret" });
    const daemon = new FakeDaemon("https://active.test");
    const requests: string[] = [];

    await runHubConnect(
      undefined,
      {},
      {
        env: {},
        credentials,
        hub: {
          issueEnrollmentToken: async (origin, credential) => {
            requests.push(`${origin}:${credential}`);
            return "one-time-enrollment-token-with-enough-length";
          },
        },
        daemon: new FakeDaemonConnection(daemon),
        reporter: quietReporter,
      },
    );

    assert.deepEqual(requests, ["https://active.test:active-secret"]);
  });

  it("connect without authority reports the hosted destination and contacts nothing", async () => {
    const progress: string[] = [];
    const credentials = new MemoryCredentials();
    const daemon = new FakeDaemonConnection(new FakeDaemon("https://hub.paseo.sh"));
    let hubRequests = 0;

    await assert.rejects(
      runHubConnect(
        undefined,
        {},
        {
          env: {},
          credentials,
          hub: {
            issueEnrollmentToken: async () => {
              hubRequests += 1;
              return "one-time-enrollment-token-with-enough-length";
            },
          },
          daemon,
          reporter: { progress: (message) => progress.push(message) },
        },
      ),
      {
        code: "HUB_API_KEY_REQUIRED",
        message:
          "No stored Hub login matches https://hub.paseo.sh. Run `paseo hub login https://hub.paseo.sh`, pass --api-key <secret>, or set PASEO_HUB_API_KEY.",
      },
    );

    assert.deepEqual(progress, ["Connecting this daemon to https://hub.paseo.sh"]);
    assert.equal(hubRequests, 0);
    assert.equal(daemon.connectionCount, 0);
  });

  it("projects uses explicit API-key authority and renders auditable JSON output", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://stored.test", credential: "stored-secret" });
    const requests: Array<{ origin: string; credential: string }> = [];

    const progress: string[] = [];
    const result = await runHubProjects(
      { hub: "https://explicit.test", apiKey: "explicit-secret", json: true },
      {
        env: { PASEO_HUB_URL: "https://env.test", PASEO_HUB_API_KEY: "env-secret" },
        credentials,
        hub: {
          listProjects: async (origin, credential) => {
            requests.push({ origin, credential });
            return [
              {
                id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663",
                slug: "paseo",
                name: "Paseo",
              },
            ];
          },
        },
        reporter: { progress: (message) => progress.push(message) },
      },
    );

    assert.deepEqual(requests, [
      { origin: "https://explicit.test", credential: "explicit-secret" },
    ]);
    assert.deepEqual(JSON.parse(render(result, { format: "json" })), {
      origin: "https://explicit.test",
      projects: [
        {
          id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663",
          slug: "paseo",
          name: "Paseo",
        },
      ],
    });
    assert.deepEqual(progress, []);
  });

  it("noninteractive logout removes only the human credential without daemon access", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    const connection = new FakeDaemonConnection(new FakeDaemon("https://hub.test"));
    const progress: string[] = [];

    const result = await runHubLogout(
      { json: true },
      {
        credentials,
        daemon: connection,
        isInteractive: () => true,
        confirmDisconnect: async () => {
          throw new Error("must not prompt");
        },
        reporter: { progress: (message) => progress.push(message) },
      },
    );

    assert.equal(credentials.active(), null);
    assert.equal(connection.connectionCount, 0);
    assert.equal(result.data.daemonDisconnected, false);
    assert.deepEqual(progress, []);
  });

  it("interactive logout offers a same-origin daemon disconnect and treats declining as normal", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    credentials.save({ origin: "https://other.test", credential: "other-secret" });
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    const daemon = new FakeDaemon("https://hub.test");
    const prompts: string[] = [];
    const progress: string[] = [];

    const result = await runHubLogout(
      {},
      {
        credentials,
        daemon: new FakeDaemonConnection(daemon),
        isInteractive: () => true,
        confirmDisconnect: async (origin) => {
          prompts.push(origin);
          return false;
        },
        reporter: { progress: (message) => progress.push(message) },
      },
    );

    assert.deepEqual(prompts, ["https://hub.test"]);
    assert.equal(daemon.disconnects, 0);
    assert.equal(credentials.get("https://other.test")?.credential, "other-secret");
    assert.equal(result.data.status, "logged_out");
    assert.deepEqual(progress, ["Logging out of https://hub.test"]);
  });

  it("interactive logout preserves human authority when daemon inspection fails", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });

    await assert.rejects(
      runHubLogout(
        {},
        {
          credentials,
          daemon: {
            connect: async () => {
              throw new Error("daemon unavailable");
            },
          },
          isInteractive: () => true,
          confirmDisconnect: async () => {
            throw new Error("must not prompt without relationship status");
          },
          reporter: quietReporter,
        },
      ),
      /daemon unavailable/u,
    );

    assert.equal(credentials.active()?.credential, "human-secret");
  });

  it("explicit logout automation disconnects only a daemon related to the active Hub", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    const daemon = new FakeDaemon("https://hub.test");
    daemon.beforeDisconnect = () => {
      assert.equal(credentials.active()?.credential, "human-secret");
    };
    const result = await runHubLogout(
      { json: true, disconnectDaemon: true, force: true },
      {
        credentials,
        daemon: new FakeDaemonConnection(daemon),
        isInteractive: () => false,
        confirmDisconnect: async () => false,
        reporter: quietReporter,
      },
    );

    assert.equal(daemon.disconnects, 1);
    assert.deepEqual(daemon.disconnectForces, [true]);
    assert.equal(result.data.daemonDisconnected, true);
    assert.equal(result.data.warning, undefined);
  });

  it("logout reports a daemon disconnect warning", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    const daemon = new FakeDaemon("https://hub.test");
    daemon.disconnectWarning = "Hub could not be reached; cleanup may remain pending.";

    const result = await runHubLogout(
      { json: true, disconnectDaemon: true },
      {
        credentials,
        daemon: new FakeDaemonConnection(daemon),
        isInteractive: () => false,
        confirmDisconnect: async () => false,
        reporter: quietReporter,
      },
    );

    assert.equal(result.data.daemonDisconnected, true);
    assert.equal(result.data.warning, "Hub could not be reached; cleanup may remain pending.");
  });

  it("disconnect reports clean local status without a ghost Hub origin", async () => {
    const daemon = new FakeDaemon("https://hub.test");
    const progress: string[] = [];

    const result = await runHubDisconnect(
      {},
      {
        daemon: new FakeDaemonConnection(daemon),
        reporter: { progress: (message) => progress.push(message) },
      },
    );

    assert.deepEqual(progress, ["Disconnecting this daemon from https://hub.test"]);
    assert.equal(result.data[0]?.hub, null);
  });

  it("preserves login when an accepted daemon disconnect fails", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    const daemon = new FakeDaemon("https://hub.test");
    daemon.disconnectError = new Error("Hub refused disconnect");
    const progress: string[] = [];

    await assert.rejects(
      runHubLogout(
        {},
        {
          credentials,
          daemon: new FakeDaemonConnection(daemon),
          isInteractive: () => true,
          confirmDisconnect: async () => true,
          reporter: { progress: (message) => progress.push(message) },
        },
      ),
      /Hub refused disconnect/u,
    );

    assert.equal(credentials.active()?.credential, "human-secret");
    assert.deepEqual(progress, [
      "Logging out of https://hub.test",
      "Disconnecting this daemon from https://hub.test",
    ]);
  });
});

class MemoryCredentials implements HubCredentialStore {
  private activeOrigin: string | null = null;
  private readonly records = new Map<string, StoredHubCredential>();

  active(): StoredHubCredential | null {
    return this.activeOrigin === null ? null : (this.records.get(this.activeOrigin) ?? null);
  }

  get(origin: string): StoredHubCredential | null {
    return this.records.get(origin) ?? null;
  }

  save(credential: StoredHubCredential): void {
    const origin = new URL(credential.origin).origin;
    this.records.set(origin, { ...credential, origin });
    this.activeOrigin = origin;
  }

  logoutActive(): StoredHubCredential | null {
    const active = this.active();
    if (active !== null) this.records.delete(active.origin);
    this.activeOrigin = null;
    return active;
  }
}

class FakeDaemonConnection implements HubDaemonConnection {
  connectionCount = 0;

  constructor(private readonly daemon: FakeDaemon) {}

  async connect(): Promise<HubDaemonClient> {
    this.connectionCount += 1;
    return this.daemon;
  }
}

class FakeDaemon implements HubDaemonClient {
  readonly connections: Array<{ origin: string; token: string }> = [];
  disconnects = 0;
  readonly disconnectForces: boolean[] = [];
  disconnectError: Error | null = null;
  disconnectWarning: string | null = null;
  beforeDisconnect: (() => void) | null = null;

  constructor(private readonly origin: string) {}

  async connectHub(origin: string, token: string) {
    this.connections.push({ origin, token });
    return { status: hubStatus("connected", origin) };
  }

  async getHubStatus() {
    return { status: hubStatus("connected", this.origin) };
  }

  async disconnectHub(force: boolean) {
    this.disconnects += 1;
    this.disconnectForces.push(force);
    this.beforeDisconnect?.();
    if (this.disconnectError !== null) throw this.disconnectError;
    return {
      status: hubStatus("not_connected", null),
      ...(this.disconnectWarning ? { warning: this.disconnectWarning } : {}),
    };
  }

  async close() {}
}

function hubStatus(state: string, origin: string | null): HubStatus {
  return {
    state,
    daemonId: state === "connected" ? "daemon-1" : null,
    hubOrigin: origin,
    scopes: state === "connected" ? ["hub.execution.*"] : [],
    connectedAt: null,
    lastError: null,
  };
}
