import { afterEach, describe, expect, test } from "vitest";
import { createPaseoApi, type DaemonClientsSnapshot } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
});

async function startDaemon(): Promise<TestPaseoDaemon> {
  const instance = await createTestPaseoDaemon();
  cleanup.push(() => instance.close());
  return instance;
}

function findClientSocketCount(
  snapshots: readonly DaemonClientsSnapshot[],
  name: string,
): number | undefined {
  return snapshots.at(-1)?.clients.find((entry) => entry.name === name)?.socketCount;
}

describe("daemon.clients.list", () => {
  test("lists and observes live clients with clientInfo, scopes, and access.manage enforcement", async () => {
    const host = await startDaemon();

    const owner = createHostClient(`127.0.0.1:${host.port}`, {
      clientId: "cid_desktop_owner",
      clientType: "mobile",
      appVersion: "0.18.1",
      clientInfo: { name: "Mo's MacBook Pro", platform: "macos", kind: "desktop" },
      reconnect: { enabled: false },
    });
    await owner.connect();
    cleanup.push(() => owner.close());

    expect(owner.getLastServerInfoMessage()?.features?.connectedClients).toBe(true);

    const observed: DaemonClientsSnapshot[] = [];
    const subscription = owner.observeConnectedClients();
    const unsubscribe = subscription.subscribe({
      snapshot: (snapshot) => observed.push(snapshot),
      update: (message) => {
        if (message.type === "daemon.clients.changed") {
          observed.push({
            clients: message.payload.clients,
            inboundDaemons: message.payload.inboundDaemons,
          });
        }
      },
    });
    cleanup.push(async () => {
      unsubscribe();
      await subscription.release();
    });

    const initial = await subscription.ready;
    expect(initial.clients).toHaveLength(1);
    expect(initial.clients[0]).toMatchObject({
      isCurrentSession: true,
      name: "Mo's MacBook Pro",
      kind: "desktop",
      platform: "macos",
      appVersion: "0.18.1",
      transport: "local",
      socketCount: 1,
    });

    // Connect a second client with narrowed read-only permissions.
    const viewer = createHostClient(`127.0.0.1:${host.port}`, {
      clientId: "cid_phone_viewer",
      clientType: "mobile",
      appVersion: "0.18.1",
      clientInfo: { name: "Mo's iPhone", platform: "ios", kind: "mobile" },
      sessionPermissions: ["daemon.read", "workspace.read"],
      reconnect: { enabled: false },
    });
    await viewer.connect();
    cleanup.push(() => viewer.close());

    await expect.poll(() => observed.at(-1)?.clients.length ?? 0, { timeout: 5000 }).toBe(2);

    const latest = observed.at(-1)!;
    const phone = latest.clients.find((entry) => entry.name === "Mo's iPhone");
    expect(phone).toMatchObject({
      isCurrentSession: false,
      name: "Mo's iPhone",
      kind: "mobile",
      platform: "ios",
      permissions: ["daemon.read", "workspace.read"],
      socketCount: 1,
    });

    // The read-only client lacks access.manage and must be denied.
    await expect(viewer.listConnectedClients()).rejects.toThrow();

    // Closing the second client drops its live socketCount to 0 (reconnect grace) and notifies observers.
    await viewer.close();
    await expect
      .poll(() => findClientSocketCount(observed, "Mo's iPhone"), { timeout: 5000 })
      .toBe(0);
  });

  test("reports outbound host scopes/version on A and inbound daemon + routed sessions on B", async () => {
    const a = await startDaemon();
    const b = await startDaemon();

    const clientA = createHostClient(`127.0.0.1:${a.port}`, {
      clientId: "cid_a_owner",
      clientType: "mobile",
      clientInfo: { name: "Laptop", platform: "macos", kind: "desktop" },
      reconnect: { enabled: false },
    });
    await clientA.connect();
    const paseoA = createPaseoApi(clientA);
    cleanup.push(async () => {
      await paseoA.dispose();
      await clientA.close();
    });

    const clientB = createHostClient(`127.0.0.1:${b.port}`, {
      clientId: "cid_b_owner",
      clientType: "mobile",
      clientInfo: { name: "Server UI", platform: "linux", kind: "desktop" },
      reconnect: { enabled: false },
    });
    await clientB.connect();
    cleanup.push(() => clientB.close());

    await paseoA.hosts.add({
      connection: `127.0.0.1:${b.port}`,
      label: "build-box",
    });

    let outboundHost: Awaited<ReturnType<typeof paseoA.hosts.list>>["hosts"][number] | undefined;
    await expect
      .poll(
        async () => {
          const dir = await paseoA.hosts.list();
          outboundHost = dir.hosts[0];
          return outboundHost?.status;
        },
        { timeout: 15000 },
      )
      .toBe("online");

    expect(outboundHost?.version).toBeTruthy();
    expect(outboundHost?.permissions?.length).toBeGreaterThan(0);
    expect(outboundHost?.connectedAt).toBeTruthy();

    // Open a routed client from A to B so B observes both the inbound daemon link and its routed session.
    const serverIdA = clientA.getLastServerInfoMessage()!.serverId;
    const serverIdB = clientB.getLastServerInfoMessage()!.serverId;
    const remoteB = await paseoA.hosts.client(serverIdB);
    cleanup.push(() => remoteB.dispose());

    await expect
      .poll(
        async () => {
          const snapshot = await clientB.listConnectedClients();
          return snapshot.inboundDaemons[0]?.routedSessions.length ?? 0;
        },
        { timeout: 10000 },
      )
      .toBe(1);

    const snapshotB = await clientB.listConnectedClients();
    expect(snapshotB.inboundDaemons).toHaveLength(1);
    expect(snapshotB.inboundDaemons[0]).toMatchObject({
      peerServerId: serverIdA,
      transport: "local",
      socketCount: 1,
    });
    expect(snapshotB.inboundDaemons[0]?.permissions.length).toBeGreaterThan(0);
    expect(snapshotB.inboundDaemons[0]?.routedSessions).toHaveLength(1);
  });
});
