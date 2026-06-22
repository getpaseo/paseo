import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import {
  DaemonSession,
  type DaemonRuntimeConfig,
  type DaemonSessionHost,
} from "./daemon-session.js";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
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

function makeSubsystem(overrides: {
  serverId?: string;
  daemonVersion?: string;
  daemonRuntimeConfig?: DaemonRuntimeConfig;
  listProviderAvailability?: () => Promise<ProviderAvailability[]>;
}) {
  const emitted: SessionOutboundMessage[] = [];
  const host: DaemonSessionHost = { emit: (msg) => emitted.push(msg) };
  const subsystem = new DaemonSession({
    host,
    paseoHome: makeHome(),
    serverId: overrides.serverId,
    daemonVersion: overrides.daemonVersion,
    daemonRuntimeConfig: overrides.daemonRuntimeConfig,
    listProviderAvailability: overrides.listProviderAvailability ?? (async () => []),
    logger: pino({ level: "silent" }),
  });
  return { subsystem, emitted };
}

describe("DaemonSession", () => {
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
});
