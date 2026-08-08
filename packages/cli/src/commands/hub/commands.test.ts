import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { render } from "../../output/index.js";
import { runHubConnect } from "./connect.js";
import type { HubCredentialStore, StoredHubCredential } from "./credentials.js";
import type { HubDaemonClient, HubDaemonConnection, HubStatus } from "./daemon-client.js";
import { runHubLogin } from "./login.js";
import { runHubLogout } from "./logout.js";
import { runHubProjects } from "./projects.js";
import { createHubCommand } from "./index.js";

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
  });

  it("login stores the durable credential and marks its normalized origin active", async () => {
    const credentials = new MemoryCredentials();

    const result = await runHubLogin("https://hub.test:443", {
      credentials,
      flow: { authorize: async () => "paseo_cli_prefix_durable-secret" },
    });

    assert.deepEqual(credentials.active(), {
      origin: "https://hub.test",
      credential: "paseo_cli_prefix_durable-secret",
    });
    assert.deepEqual(result.data, { origin: "https://hub.test", status: "logged_in" });
    assert.equal(JSON.stringify(result).includes("durable-secret"), false);
  });

  it("connect exchanges authority once and gives only the enrollment token to the daemon", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "stored-human-secret" });
    const daemon = new FakeDaemon("https://hub.test");
    const observed: Array<{ origin: string; credential: string }> = [];

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
      },
    );

    assert.deepEqual(observed, [{ origin: "https://hub.test", credential: "stored-human-secret" }]);
    assert.deepEqual(daemon.connections, [
      { origin: "https://hub.test", token: "one-time-enrollment-token-with-enough-length" },
    ]);
    assert.equal(daemon.connections[0]?.token.includes("stored-human-secret"), false);
  });

  it("projects uses explicit API-key authority and renders normal JSON list output", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://stored.test", credential: "stored-secret" });
    const requests: Array<{ origin: string; credential: string }> = [];

    const result = await runHubProjects(
      { hub: "https://explicit.test", apiKey: "explicit-secret" },
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
      },
    );

    assert.deepEqual(requests, [
      { origin: "https://explicit.test", credential: "explicit-secret" },
    ]);
    assert.deepEqual(JSON.parse(render(result, { format: "json" })), [
      { id: "a50e05af-4f20-4c8f-8dcc-58e5ea360663", slug: "paseo", name: "Paseo" },
    ]);
  });

  it("noninteractive logout removes only the human credential without daemon access", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    const connection = new FakeDaemonConnection(new FakeDaemon("https://hub.test"));

    const result = await runHubLogout(
      { json: true },
      {
        credentials,
        daemon: connection,
        isInteractive: () => true,
        confirmDisconnect: async () => {
          throw new Error("must not prompt");
        },
      },
    );

    assert.equal(credentials.active(), null);
    assert.equal(connection.connectionCount, 0);
    assert.equal(result.data.daemonDisconnected, false);
  });

  it("interactive logout offers a same-origin daemon disconnect and treats declining as normal", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    credentials.save({ origin: "https://other.test", credential: "other-secret" });
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    const daemon = new FakeDaemon("https://hub.test");
    const prompts: string[] = [];

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
      },
    );

    assert.deepEqual(prompts, ["https://hub.test"]);
    assert.equal(daemon.disconnects, 0);
    assert.equal(credentials.get("https://other.test")?.credential, "other-secret");
    assert.equal(result.data.status, "logged_out");
  });

  it("interactive logout still removes human authority when the daemon is unavailable", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });

    const result = await runHubLogout(
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
      },
    );

    assert.equal(credentials.active(), null);
    assert.equal(result.data.daemonDisconnected, false);
  });

  it("explicit logout automation disconnects only a daemon related to the active Hub", async () => {
    const credentials = new MemoryCredentials();
    credentials.save({ origin: "https://hub.test", credential: "human-secret" });
    const daemon = new FakeDaemon("https://hub.test");

    const result = await runHubLogout(
      { json: true, disconnectDaemon: true },
      {
        credentials,
        daemon: new FakeDaemonConnection(daemon),
        isInteractive: () => false,
        confirmDisconnect: async () => false,
      },
    );

    assert.equal(daemon.disconnects, 1);
    assert.equal(result.data.daemonDisconnected, true);
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

  constructor(private readonly origin: string) {}

  async connectHub(origin: string, token: string) {
    this.connections.push({ origin, token });
    return { status: hubStatus("connected", origin) };
  }

  async getHubStatus() {
    return { status: hubStatus("connected", this.origin) };
  }

  async disconnectHub() {
    this.disconnects += 1;
    return { status: hubStatus("not_connected", null) };
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
