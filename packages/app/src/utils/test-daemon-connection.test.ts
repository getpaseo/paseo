import { describe, expect, it, vi, beforeEach } from "vitest";

const daemonClientMock = vi.hoisted(() => {
  const createdConfigs: Array<{ clientId?: string; url?: string; password?: string }> = [];
  let nextConnectError: Error | null = null;
  let nextLastError: string | null = null;

  class MockDaemonClient {
    public lastError: string | null = nextLastError;
    private lastServerInfo = {
      status: "server_info" as const,
      serverId: "srv_probe_test",
      hostname: "probe-host" as string | null,
      version: "0.0.0",
    };

    constructor(config: { clientId?: string; url?: string; password?: string }) {
      createdConfigs.push(config);
    }

    subscribeConnectionStatus(): () => void {
      return () => undefined;
    }

    on(): () => void {
      return () => undefined;
    }

    async connect(): Promise<void> {
      if (nextConnectError) {
        throw nextConnectError;
      }
      return;
    }

    getLastServerInfoMessage() {
      return this.lastServerInfo;
    }

    async ping(): Promise<{ rttMs: number }> {
      return { rttMs: 42 };
    }

    async close(): Promise<void> {
      return;
    }
  }

  return {
    MockDaemonClient,
    createdConfigs,
    setNextConnectFailure: (error: Error, lastError: string | null) => {
      nextConnectError = error;
      nextLastError = lastError;
    },
    reset: () => {
      createdConfigs.length = 0;
      nextConnectError = null;
      nextLastError = null;
    },
  };
});

const clientIdMock = vi.hoisted(() => ({
  getOrCreateClientId: vi.fn(async () => "cid_shared_probe_test"),
}));

vi.mock("@server/client/daemon-client", () => ({
  DaemonClient: daemonClientMock.MockDaemonClient,
}));

vi.mock("./client-id", () => ({
  getOrCreateClientId: clientIdMock.getOrCreateClientId,
}));

vi.mock("@/desktop/daemon/desktop-daemon-transport", () => ({
  createDesktopLocalDaemonTransportFactory: vi.fn(() => null),
  buildLocalDaemonTransportUrl: vi.fn(
    ({
      transportType,
      transportPath,
    }: {
      transportType: "socket" | "pipe";
      transportPath: string;
    }) => `paseo+local://${transportType}?path=${encodeURIComponent(transportPath)}`,
  ),
}));

describe("test-daemon-connection connectToDaemon", () => {
  beforeEach(() => {
    daemonClientMock.reset();
    clientIdMock.getOrCreateClientId.mockClear();
    vi.stubGlobal("__DEV__", false);
  });

  it("reuses the app clientId for direct connections", async () => {
    const mod = await import("./test-daemon-connection");

    const first = await mod.connectToDaemon({
      id: "direct:lan:6767",
      type: "directTcp",
      endpoint: "lan:6767",
    });
    await first.client.close();

    const second = await mod.connectToDaemon({
      id: "direct:lan:6767",
      type: "directTcp",
      endpoint: "lan:6767",
    });
    await second.client.close();

    const [firstConfig, secondConfig] = daemonClientMock.createdConfigs;
    expect(firstConfig?.clientId).toBe("cid_shared_probe_test");
    expect(secondConfig?.clientId).toBe("cid_shared_probe_test");
    expect(clientIdMock.getOrCreateClientId).toHaveBeenCalledTimes(2);
  });

  it("encodes the local socket target into the client config", async () => {
    const mod = await import("./test-daemon-connection");

    const result = await mod.connectToDaemon({
      id: "socket:/tmp/paseo.sock",
      type: "directSocket",
      path: "/tmp/paseo.sock",
    });
    await result.client.close();

    expect(daemonClientMock.createdConfigs[0]?.url).toBe(
      "paseo+local://socket?path=%2Ftmp%2Fpaseo.sock",
    );
  });

  it("passes direct TCP connection passwords into the client config", async () => {
    const mod = await import("./test-daemon-connection");

    const result = await mod.connectToDaemon({
      id: "direct:lan:6767",
      type: "directTcp",
      endpoint: "lan:6767",
      password: "shared-secret",
    });
    await result.client.close();

    expect(daemonClientMock.createdConfigs[0]?.password).toBe("shared-secret");
  });

  it("surfaces auth rejection as an incorrect password", async () => {
    const mod = await import("./test-daemon-connection");
    daemonClientMock.setNextConnectFailure(
      new Error("Transport closed (code 4001)"),
      "Transport closed (code 4001)",
    );

    await expect(
      mod.connectToDaemon({
        id: "direct:lan:6767",
        type: "directTcp",
        endpoint: "lan:6767",
        password: "wrong-secret",
      }),
    ).rejects.toMatchObject({
      message: "Incorrect password",
    });
  });

  it("keeps generic transport failures generic when a password was supplied", async () => {
    const mod = await import("./test-daemon-connection");
    daemonClientMock.setNextConnectFailure(new Error("Transport error"), "Transport error");

    await expect(
      mod.connectToDaemon({
        id: "direct:lan:6767",
        type: "directTcp",
        endpoint: "lan:6767",
        password: "shared-secret",
      }),
    ).rejects.toMatchObject({
      message: "Transport error",
    });
  });
});
