import { expect, test } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { OrderRecord } from "@getpaseo/protocol/ordering";

test("two clients share workspace and tab order, stale writes lose, reconnect reads authority", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const clients = Array.from(
    { length: 3 },
    () => new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.11.2" }),
  );
  try {
    await Promise.all(clients.map((client) => client.connect()));
    const [desktop, mobile, idle] = clients;
    expect(desktop!.getLastServerInfoMessage()?.features?.sharedOrdering).toBe(true);
    const cwd = join(daemon.paseoHome, "ordering-project");
    await mkdir(cwd);
    const first = await desktop!.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "First",
    });
    expect(first.error).toBeNull();
    const workspace = first.workspace!;
    const second = await desktop!.createWorkspace({
      source: { kind: "directory", path: cwd, projectId: workspace.projectId },
      title: "Second",
    });
    expect(second.error).toBeNull();
    const scope = { kind: "workspaces", projectId: workspace.projectId } as const;
    const mobileRecords: OrderRecord[] = [];
    const subscription = mobile!.observeOrders();
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "ui.order.update" && message.payload.record)
          mobileRecords.push(message.payload.record);
      },
    });
    await subscription.ready;
    const idleUpdates: unknown[] = [];
    const stopIdle = idle!.on("ui.order.update", (message) => idleUpdates.push(message));
    const sharedOrder = [second.workspace!.id, workspace.id];
    const changed = await desktop!.setOrder({ scope, expectedRevision: 0, order: sharedOrder });
    expect(changed.accepted).toBe(true);
    await expect.poll(() => mobileRecords).toEqual([{ scope, revision: 1, order: sharedOrder }]);
    const stale = await mobile!.setOrder({
      scope,
      expectedRevision: 0,
      order: sharedOrder.toReversed(),
    });
    expect(stale.accepted).toBe(false);
    expect(stale.record.order).toEqual(sharedOrder);
    const tabScope = { kind: "tabs", workspaceId: workspace.id } as const;
    await mobile!.setOrder({ scope: tabScope, expectedRevision: 0, order: ["files", "agent_a"] });
    expect((await desktop!.listOrders()).records).toEqual([
      changed.record,
      { scope: tabScope, revision: 1, order: ["files", "agent_a"] },
    ]);
    const expected = (await mobile!.listOrders()).records;
    await desktop!.close();
    const reconnected = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.11.2",
    });
    clients.push(reconnected);
    await reconnected.connect();
    const reconnect = reconnected.observeOrders();
    expect((await reconnect.ready).records).toEqual(expected);
    await reconnect.release();
    await subscription.release();
    const count = mobileRecords.length;
    await reconnected.setOrder({ scope, expectedRevision: 1, order: sharedOrder.toReversed() });
    await mobile!.listOrders();
    expect(mobileRecords).toHaveLength(count);
    expect(idleUpdates).toEqual([]);
    stopIdle();
    await expect(
      reconnected.setOrder({ scope, expectedRevision: 2, order: ["foreign-workspace"] }),
    ).rejects.toThrow("outside its scope");
    await reconnected.archiveWorkspace(workspace.id);
    await expect
      .poll(async () => (await reconnected.listOrders()).records)
      .toEqual([{ scope, revision: 3, order: [second.workspace!.id] }]);
    await reconnected.removeProject(workspace.projectId);
    expect((await reconnected.listOrders()).records).toEqual([]);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await daemon.close();
  }
}, 60000);

test("unpinning and archiving prune shared pinned order", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.2",
  });
  try {
    await client.connect();
    const cwd = join(daemon.paseoHome, "pinned-project");
    await mkdir(cwd);
    const first = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
    expect(first.error).toBeNull();
    const second = await client.createWorkspace({
      source: { kind: "directory", path: cwd, projectId: first.workspace!.projectId },
    });
    expect(second.error).toBeNull();
    await client.setWorkspacePinned(first.workspace!.id, true);
    await client.setWorkspacePinned(second.workspace!.id, true);
    const scope = { kind: "pinned" } as const;
    await client.setOrder({
      scope,
      expectedRevision: 0,
      order: [first.workspace!.id, second.workspace!.id],
    });
    await client.setWorkspacePinned(first.workspace!.id, false);
    expect((await client.listOrders()).records).toEqual([
      { scope, revision: 2, order: [second.workspace!.id] },
    ]);
    await client.archiveWorkspace(second.workspace!.id);
    expect((await client.listOrders()).records).toEqual([{ scope, revision: 3, order: [] }]);
    await client.removeProject(first.workspace!.projectId);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60000);
