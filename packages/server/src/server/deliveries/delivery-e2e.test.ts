import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];

async function createClient(daemon: TestPaseoDaemon): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "durable-delivery-client",
    reconnect: { enabled: false },
  });
  await client.connect();
  return client;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("recovers durable deliveries across reconnect and daemon restart", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-delivery-e2e-"));
  const staticDir1 = await mkdtemp(path.join(os.tmpdir(), "paseo-delivery-static-"));
  const staticDir2 = await mkdtemp(path.join(os.tmpdir(), "paseo-delivery-static-"));
  roots.push(paseoHomeRoot, staticDir1, staticDir2);

  let daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    staticDir: staticDir1,
    cleanup: false,
  });
  let client: DaemonClient | null = null;
  try {
    client = await createClient(daemon);
    const sent = await client.sendDelivery(
      { event: "agent.finished", agentId: "agent-e2e" },
      { deliveryId: "delivery-e2e" },
    );
    expect(sent).toMatchObject({ deliveryId: "delivery-e2e", acknowledgedAt: null });
    await client.close();
    client = null;

    client = await createClient(daemon);
    await expect(
      client.sendDelivery(
        { event: "agent.finished", agentId: "agent-e2e" },
        { deliveryId: "delivery-e2e" },
      ),
    ).resolves.toMatchObject({
      deliveryId: "delivery-e2e",
    });
    await expect(client.getDeliveries()).resolves.toMatchObject({
      deliveries: [expect.objectContaining({ deliveryId: "delivery-e2e" })],
    });
    await client.close();
    client = null;

    await daemon.close();
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir: staticDir2,
      cleanup: false,
    });

    client = await createClient(daemon);
    await expect(client.getDeliveries()).resolves.toMatchObject({
      deliveries: [expect.objectContaining({ deliveryId: "delivery-e2e" })],
    });
    await expect(client.acknowledgeDelivery("delivery-e2e")).rejects.toMatchObject({
      code: "delivery_transition_invalid",
    });
    await expect(client.getDeliveries()).resolves.toMatchObject({
      deliveries: [expect.objectContaining({ deliveryId: "delivery-e2e", status: "recorded" })],
    });
  } finally {
    await client?.close().catch(() => undefined);
    await daemon.close();
  }
});
