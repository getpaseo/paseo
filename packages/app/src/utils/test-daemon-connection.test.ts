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

vi.mock("@server/client/daemon-client", () => ({
  DaemonClient: daemonClientMock.MockDaemonClient,
}));

describe("test-daemon-connection probe client identity", () => {
  beforeEach(() => {
    daemonClientMock.createdConfigs.length = 0;
  });

  it("uses isolated probe clientId values for direct latency probes", async () => {
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
    expect(first?.clientId).toMatch(/^cid_probe_/);
    expect(second?.clientId).toMatch(/^cid_probe_/);
    expect(first?.clientId).not.toBe(second?.clientId);
  });
});
