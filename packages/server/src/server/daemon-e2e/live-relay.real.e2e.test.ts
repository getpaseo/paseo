import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { generateLocalPairingOffer } from "../pairing-offer.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import {
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@getpaseo/protocol/connection-offer";

const relayEndpoint = process.env.PASEO_LIVE_RELAY_ENDPOINT ?? "paseo-relay-next.fly.dev:443";
const liveTest = process.env.RUN_LIVE_RELAY_E2E === "1" ? test : test.skip;

function requireOffer(url: string): ConnectionOffer {
  const offer = parseConnectionOfferFromUrl(url);
  if (!offer) {
    throw new Error("Pairing did not produce a relay connection offer");
  }
  return offer;
}

async function pairingOfferFor(daemon: TestPaseoDaemon): Promise<ConnectionOffer> {
  const pairing = await generateLocalPairingOffer({
    paseoHome: daemon.paseoHome,
    relayEnabled: true,
    relayEndpoint,
    relayPublicEndpoint: relayEndpoint,
    relayUseTls: true,
    relayPublicUseTls: true,
    includeQr: false,
  });
  if (!pairing.url) {
    throw new Error("Pairing did not produce a URL");
  }
  return requireOffer(pairing.url);
}

function clientFor(offer: ConnectionOffer): DaemonClient {
  return new DaemonClient({
    url: buildRelayWebSocketUrl({
      endpoint: offer.relay.endpoint,
      useTls: true,
      serverId: offer.serverId,
      role: "client",
    }),
    clientId: "clid_live_relay_acceptance",
    clientType: "cli",
    connectTimeoutMs: 30_000,
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
  });
}

describe("live hosted relay", () => {
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close();
  });

  liveTest(
    "carries a complete DaemonClient agent workflow through the hosted relay",
    async () => {
      const logger = pino({ level: "silent" });
      daemon = await createTestPaseoDaemon({
        listen: "127.0.0.1",
        relayEnabled: true,
        relayEndpoint,
        relayUseTls: true,
        agentClients: { codex: new CodexAppServerAgentClient(logger) },
        logger,
      });
      const offer = await pairingOfferFor(daemon);
      client = clientFor(offer);

      await client.connect();
      const initialAgents = await client.fetchAgents();
      const agent = await client.createAgent({
        provider: "codex",
        cwd: daemon.staticDir,
        title: "Live relay acceptance",
        modeId: "full-access",
      });
      await client.sendMessage(agent.id, "Respond with exactly: RELAY_ACCEPTANCE_OK");
      const finished = await client.waitForFinish(agent.id, 120_000);
      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 20,
        projection: "canonical",
      });
      const assistantText = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => entry.item.text)
        .join("");

      expect(initialAgents.entries).toEqual([]);
      expect(agent).toMatchObject({
        provider: "codex",
        cwd: daemon.staticDir,
        status: "idle",
      });
      expect(finished).toMatchObject({ status: "idle" });
      expect(assistantText).toMatch(/^RELAY_ACCEPTANCE_OK\s*$/);
    },
    180_000,
  );
});
