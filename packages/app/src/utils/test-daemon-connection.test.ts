import { describe, expect, it, vi, beforeEach } from "vitest";

const daemonClientMock = vi.hoisted(() => {
  const createdConfigs: Array<{ clientId?: string; url?: string }> = [];

  class MockDaemonClient {
    public lastError: string | null = null;
    private lastWelcome = {
      type: "welcome" as const,
      serverId: "srv_probe_test",
      hostname: "probe-host" as string | null,
      version: "0.0.0",
      resumed: false,
    };

    constructor(config: { clientId?: string; url?: string }) {
      createdConfigs.push(config);
    }

    subscribeConnectionStatus(): () => void {
      return () => undefined;
    }

    on(): () => void {
      return () => undefined;
    }

    async connect(): Promise<void> {
      return;
    }

    getLastWelcomeMessage() {
      return this.lastWelcome;
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

describe("test-daemon-connection probe client identity", () => {
  beforeEach(() => {
    daemonClientMock.createdConfigs.length = 0;
    clientIdMock.getOrCreateClientId.mockClear();
  });

  it("reuses the app clientId for direct latency probes", async () => {
    const mod = await import("./test-daemon-connection");

    await mod.measureConnectionLatency({
      id: "direct:lan:6767",
      type: "direct",
      endpoint: "lan:6767",
    });
    await mod.measureConnectionLatency({
      id: "direct:lan:6767",
      type: "direct",
      endpoint: "lan:6767",
    });

    const [first, second] = daemonClientMock.createdConfigs;
    expect(first?.clientId).toBe("cid_shared_probe_test");
    expect(second?.clientId).toBe("cid_shared_probe_test");
    expect(clientIdMock.getOrCreateClientId).toHaveBeenCalledTimes(2);
  });
});
