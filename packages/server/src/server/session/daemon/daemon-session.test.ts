import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import {
  DaemonSession,
  type DaemonRuntimeConfig,
  type DaemonSessionHost,
} from "./daemon-session.js";
import type { DaemonWebSocketRuntimeDiagnosticSnapshot } from "./diagnostics.js";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import type { HubRelationshipManagement } from "../../hub/relationship-controller.js";
import type { SessionOutboundMessage } from "../../messages.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "daemon-session-test-")));
  tempDirs.push(home);
  return home;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeSubsystem(overrides: {
  serverId?: string;
  daemonVersion?: string;
  daemonRuntimeConfig?: DaemonRuntimeConfig;
  listProviderAvailability?: () => Promise<ProviderAvailability[]>;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  hubRelationships?: HubRelationshipManagement;
}) {
  const emitted: SessionOutboundMessage[] = [];
  const restartIntents: Parameters<DaemonSessionHost["emitLifecycleIntent"]>[0][] = [];
  const host: DaemonSessionHost = {
    emit: (msg) => emitted.push(msg),
    emitLifecycleIntent: (intent) => restartIntents.push(intent),
  };
  const paseoHome = makeHome();
  const subsystem = new DaemonSession({
    host,
    clientId: "client-1",
    paseoHome,
    serverId: overrides.serverId,
    daemonVersion: overrides.daemonVersion,
    daemonRuntimeConfig: overrides.daemonRuntimeConfig,
    listAgents: () => [],
    listProjects: async () => [],
    listWorkspaces: async () => [],
    listProviderAvailability: overrides.listProviderAvailability ?? (async () => []),
    getWebSocketRuntimeMetrics: overrides.getWebSocketRuntimeMetrics,
    hubRelationships: overrides.hubRelationships,
    logger: pino({ level: "silent" }),
  });
  return { subsystem, emitted, paseoHome, restartIntents };
}

describe("DaemonSession", () => {
  test("Hub relationship command failures return correlated RPC errors", async () => {
    const { subsystem, emitted } = makeSubsystem({
      hubRelationships: {
        connect: async () => {
          throw new Error("Hub rejected enrollment (401)");
        },
        status: () => ({
          state: "not_connected",
          daemonId: null,
          hubOrigin: null,
          scopes: [],
          connectedAt: null,
          lastError: null,
        }),
        disconnect: async () => {
          throw new Error("Hub revocation failed (503)");
        },
      },
    });

    await subsystem.handleHubRelationshipRequest({
      type: "hub.management.daemon.connect.request",
      requestId: "connect-1",
      hubUrl: "https://hub.test",
      token: "token",
    });
    await subsystem.handleHubRelationshipRequest({
      type: "hub.management.daemon.disconnect.request",
      requestId: "disconnect-1",
      force: false,
    });

    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "connect-1",
          requestType: "hub.management.daemon.connect.request",
          error: "Hub rejected enrollment (401)",
          code: "handler_error",
        },
      },
      {
        type: "rpc_error",
        payload: {
          requestId: "disconnect-1",
          requestType: "hub.management.daemon.disconnect.request",
          error: "Hub revocation failed (503)",
          code: "handler_error",
        },
      },
    ]);
  });

  test("status reports identity, runtime config, and providers with errors normalized to null", async () => {
    const { subsystem, emitted } = makeSubsystem({
      serverId: "srv-1",
      daemonVersion: "1.2.3",
      daemonRuntimeConfig: { listen: "127.0.0.1:6767", relay: null },
      listProviderAvailability: async () => [
        { provider: "claude", available: true, error: null },
        { provider: "codex", available: false, error: "boom" },
      ],
    });

    await subsystem.handleGetStatusRequest({ type: "daemon.get_status.request", requestId: "s-1" });

    expect(emitted).toEqual([
      {
        type: "daemon.get_status.response",
        payload: {
          requestId: "s-1",
          serverId: "srv-1",
          version: "1.2.3",
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: "127.0.0.1:6767",
          relay: null,
          providers: [
            { provider: "claude", available: true, error: null },
            { provider: "codex", available: false, error: "boom" },
          ],
        },
      },
    ]);
  });

  test("status falls back to null fields and an empty provider list when listing rejects", async () => {
    const { subsystem, emitted } = makeSubsystem({
      serverId: "srv-1",
      daemonVersion: "1.2.3",
      daemonRuntimeConfig: { listen: "127.0.0.1:6767", relay: null },
      listProviderAvailability: async () => {
        throw new Error("provider listing failed");
      },
    });

    await subsystem.handleGetStatusRequest({ type: "daemon.get_status.request", requestId: "s-2" });

    expect(emitted).toEqual([
      {
        type: "daemon.get_status.response",
        payload: {
          requestId: "s-2",
          serverId: "srv-1",
          version: "1.2.3",
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: null,
          relay: null,
          providers: [],
        },
      },
    ]);
  });

  test("pairing offer is empty when relay is disabled", async () => {
    const { subsystem, emitted } = makeSubsystem({
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        relay: {
          enabled: false,
          endpoint: "relay.paseo.sh:443",
          publicEndpoint: "relay.paseo.sh:443",
          useTls: true,
          publicUseTls: true,
        },
      },
    });

    await subsystem.handleGetPairingOfferRequest({
      type: "daemon.get_pairing_offer.request",
      requestId: "p-1",
    });

    expect(emitted).toEqual([
      {
        type: "daemon.get_pairing_offer.response",
        payload: { requestId: "p-1", url: "", qr: null, relayEnabled: false },
      },
    ]);
  });

  test("pairing offer mints a real connection URL when relay is enabled", async () => {
    const { subsystem, emitted } = makeSubsystem({
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        appBaseUrl: "https://app.example.test",
        relay: {
          enabled: true,
          endpoint: "relay.example.test:443",
          publicEndpoint: "relay.example.test:443",
          useTls: true,
          publicUseTls: true,
        },
      },
    });

    await subsystem.handleGetPairingOfferRequest({
      type: "daemon.get_pairing_offer.request",
      requestId: "p-2",
    });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    expect(message.type).toBe("daemon.get_pairing_offer.response");
    if (message.type !== "daemon.get_pairing_offer.response") {
      throw new Error("expected a pairing offer response");
    }
    expect(message.payload.requestId).toBe("p-2");
    expect(message.payload.relayEnabled).toBe(true);
    expect(message.payload.url.startsWith("https://app.example.test")).toBe(true);
    expect(typeof message.payload.qr).toBe("string");
  });

  test("diagnostics includes a log tail and redacts connection secrets", async () => {
    const { subsystem, emitted, paseoHome } = makeSubsystem({
      serverId: "srv-1",
      daemonVersion: "1.2.3",
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        relay: {
          enabled: true,
          endpoint: "relay.secret.test:443",
          publicEndpoint: "relay.secret.test:443",
          useTls: true,
          publicUseTls: true,
        },
      },
    });
    writeFileSync(
      join(paseoHome, "daemon.log"),
      "first line\nrelay.secret.test:443 token=super-secret paseo://pairing-secret\n",
    );

    await subsystem.handleDiagnosticsRequest({ type: "diagnostics.request", requestId: "d-1" });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    expect(message.type).toBe("diagnostics.response");
    if (message.type !== "diagnostics.response") {
      throw new Error("expected diagnostics response");
    }
    expect(message.payload.requestId).toBe("d-1");
    expect(message.payload.diagnostic).toContain("Daemon log tail");
    expect(message.payload.diagnostic).toContain("first line");
    expect(message.payload.diagnostic).not.toContain("relay.secret.test:443");
    expect(message.payload.diagnostic).not.toContain("super-secret");
    expect(message.payload.diagnostic).not.toContain("pairing-secret");
  });

  test("diagnostics includes the PATH and shell visible to the daemon", async () => {
    const originalPath = process.env.PATH;
    const originalShell = process.env.SHELL;
    const originalComSpec = process.env.ComSpec;
    const originalCOMSPEC = process.env.COMSPEC;
    try {
      process.env.PATH = "/opt/paseo-test/bin:/usr/bin";
      process.env.SHELL = "/bin/paseo-test-shell";
      delete process.env.ComSpec;
      delete process.env.COMSPEC;

      const { subsystem, emitted } = makeSubsystem({});

      await subsystem.handleDiagnosticsRequest({ type: "diagnostics.request", requestId: "d-env" });

      expect(emitted).toHaveLength(1);
      const message = emitted[0];
      expect(message.type).toBe("diagnostics.response");
      if (message.type !== "diagnostics.response") {
        throw new Error("expected diagnostics response");
      }
      expect(message.payload.diagnostic).toContain("PATH: /opt/paseo-test/bin:/usr/bin");
      expect(message.payload.diagnostic).toContain("Shell: SHELL=/bin/paseo-test-shell");
    } finally {
      restoreEnv("PATH", originalPath);
      restoreEnv("SHELL", originalShell);
      restoreEnv("ComSpec", originalComSpec);
      restoreEnv("COMSPEC", originalCOMSPEC);
    }
  });

  test("diagnostics includes the last flushed websocket runtime metrics", async () => {
    const { subsystem, emitted } = makeSubsystem({
      getWebSocketRuntimeMetrics: () => ({
        collectedAt: "2026-01-02T03:04:05.000Z",
        windowMs: 30_000,
        uptimeSeconds: 12.345,
        memory: {
          rss: 1024 * 1024 * 64,
          heapTotal: 1024 * 1024 * 32,
          heapUsed: 1024 * 1024 * 12,
          external: 1024 * 1024 * 3,
          arrayBuffers: 1024 * 512,
        },
        final: false,
        sessions: {
          activeConnections: 2,
          externalSessionKeys: 3,
          reconnectGraceSessions: 1,
        },
        sockets: {
          activeSockets: 2,
          pendingConnections: 1,
        },
        counters: {
          connectedAwaitingHello: 1,
          helloResumed: 0,
          helloNew: 2,
          pendingDisconnected: 0,
          sessionDisconnectedWaitingReconnect: 0,
          sessionSocketDisconnectedAttached: 0,
          sessionCleanup: 0,
          validationFailed: 0,
          binaryBeforeHelloRejected: 0,
          pendingMessageRejectedBeforeHello: 0,
          missingConnectionForMessage: 0,
          unexpectedHelloOnActiveConnection: 0,
          relayExternalSocketAttached: 0,
          originRejected: 0,
          hostRejected: 0,
        },
        inboundMessageTypesTop: [["session", 4]],
        inboundSessionRequestTypesTop: [["diagnostics.request", 2]],
        outboundMessageTypesTop: [["session_message", 5]],
        outboundSessionMessageTypesTop: [["diagnostics.response", 2]],
        outboundAgentStreamTypesTop: [["timeline:message", 3]],
        outboundAgentStreamAgentsTop: [["agent-1", 3]],
        outboundBinaryFrameTypesTop: [["binary", 1]],
        bufferedAmount: {
          p95: 128,
          max: 256,
        },
        eventLoopDelay: {
          p50Ms: 1,
          p99Ms: 4,
          maxMs: 7,
        },
        runtime: {
          inflightRequests: 1,
          peakInflightRequests: 3,
          terminalSubscriptionCount: 4,
          terminalDirectorySubscriptionCount: 5,
          checkoutDiffTargetCount: 6,
          checkoutDiffSubscriptionCount: 7,
          checkoutDiffWatcherCount: 8,
          checkoutDiffFallbackRefreshTargetCount: 9,
        },
        latency: [
          {
            type: "diagnostics.request",
            count: 2,
            minMs: 3,
            maxMs: 7,
            p50Ms: 4,
            totalMs: 11,
          },
        ],
        agents: {
          total: 10,
          byLifecycle: {
            idle: 8,
            running: 2,
          },
          withActiveForegroundTurn: 2,
          timelineStats: {
            totalItems: 42,
            maxItemsPerAgent: 12,
          },
        },
      }),
    });

    await subsystem.handleDiagnosticsRequest({ type: "diagnostics.request", requestId: "d-2" });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    expect(message.type).toBe("diagnostics.response");
    if (message.type !== "diagnostics.response") {
      throw new Error("expected diagnostics response");
    }
    expect(message.payload.diagnostic).toContain("WebSocket runtime metrics");
    expect(message.payload.diagnostic).toContain("Collected at: 2026-01-02T03:04:05.000Z");
    expect(message.payload.diagnostic).toContain("Process uptime: 12s");
    expect(message.payload.diagnostic).toContain(
      "Process memory: rss=64.0 MiB, heap=12.0 MiB / 32.0 MiB",
    );
    expect(message.payload.diagnostic).toContain(
      "Sessions: active=2, externalKeys=3, reconnectGrace=1",
    );
    expect(message.payload.diagnostic).toContain(
      "Latency: diagnostics.request count=2 p50=4ms max=7ms total=11ms",
    );
    expect(message.payload.diagnostic).toContain("Inbound session requests: diagnostics.request=2");
    expect(message.payload.diagnostic).toContain(
      "Checkout diff: targets=6, subscriptions=7, watchers=8, fallbackRefreshTargets=9",
    );
    expect(message.payload.diagnostic).toContain("Agent lifecycle: idle=8, running=2");
  });
});
