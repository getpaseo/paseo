import { OrderReplica, type OrderMembership } from "../../../../app/src/ordering/replica.js";
import { createOrderMove } from "../../../../app/src/ordering/move.js";
import { expect, test } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { applySharedOrder, type OrderRecord } from "@getpaseo/protocol/ordering";

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
    await mobile!.setOrderTargets({
      expectedRevision: 0,
      workspaces: [{ workspaceId: workspace.id, targets: ["files", "agent_a"] }],
    });
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

test("real clients retain offline exact moves and file/browser inventories until explicit forget", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const desktop = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "order-desktop",
    appVersion: "0.11.2",
  });
  let mobile = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "order-mobile",
    appVersion: "0.11.2",
  });
  const errors: unknown[] = [];
  try {
    await Promise.all([desktop.connect(), mobile.connect()]);
    const cwd = join(daemon.paseoHome, "full-order");
    await mkdir(cwd);
    const created = await desktop.createWorkspace({ source: { kind: "directory", path: cwd } });
    const workspace = created.workspace!;
    const scope = { kind: "tabs", workspaceId: workspace.id } as const;
    const keys = ["agent_a", "file_readme", "browser_1", "terminal_t"];
    const workspaces = [{ workspaceId: workspace.id, targets: keys }];
    await desktop.listOrders();
    await mobile.listOrders();
    await desktop.setOrderTargets({ expectedRevision: 0, workspaces });
    await mobile.setOrderTargets({ expectedRevision: 0, workspaces });
    await desktop.setOrder({ scope, expectedRevision: 0, order: keys });
    const replica = new OrderReplica({
      membership: () => "all",
      port: { setOrder: (input) => mobile.setOrder(input) },
      apply: () => {},
      failed: (error) => errors.push(error),
    });
    replica.reorder({
      scope,
      move: createOrderMove({ moved: "browser_1", order: ["browser_1", "agent_a"] }),
    });
    const latest = await mobile.listOrders();
    replica.snapshot(latest.records);
    await expect
      .poll(async () => (await desktop.listOrders()).records[0]!.order)
      .toEqual(["browser_1", "agent_a", "file_readme", "terminal_t"]);
    replica.pause();
    await mobile.close();
    replica.reorder({
      scope,
      move: createOrderMove({ moved: "file_readme", order: ["file_readme", "browser_1"] }),
    });
    const current = (await desktop.listOrders()).records[0]!;
    await desktop.setOrder({
      scope,
      expectedRevision: current.revision,
      order: ["terminal_t", "browser_1", "agent_a", "file_readme"],
    });
    await desktop.setOrderTargets({ expectedRevision: 1, workspaces: [] });
    expect((await desktop.listOrders()).records[0]!.order).toEqual([
      "terminal_t",
      "browser_1",
      "agent_a",
      "file_readme",
    ]);
    mobile = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "order-mobile",
      appVersion: "0.11.2",
    });
    await mobile.connect();
    replica.snapshot((await mobile.listOrders()).records);
    await expect
      .poll(async () => (await desktop.listOrders()).records[0]!.order)
      .toEqual(["terminal_t", "file_readme", "browser_1", "agent_a"]);
    expect(errors).toEqual([]);
    await desktop.forgetOrderDevice({ clientId: "order-mobile" });
    expect((await desktop.listOrders()).records[0]!.order).toEqual([]);
    await expect(mobile.setOrderTargets({ expectedRevision: 2, workspaces })).rejects.toThrow(
      "forgotten",
    );
    await desktop.removeProject(workspace.projectId);
  } finally {
    await Promise.all([desktop.close(), mobile.close()]);
    await daemon.close();
  }
}, 60000);

test("first explicit drag initializes four targets and concurrent initialization replays only the losing move", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const clients = ["first", "second"].map(
    (clientId) =>
      new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        clientId,
        appVersion: "0.11.2",
      }),
  );
  const errors: unknown[] = [];
  try {
    await Promise.all(clients.map((client) => client.connect()));
    const [desktop, mobile] = clients;
    const cwd = join(daemon.paseoHome, "first-drag");
    await mkdir(cwd);
    const created = await desktop!.createWorkspace({ source: { kind: "directory", path: cwd } });
    const workspace = created.workspace!;
    const scope = { kind: "tabs", workspaceId: workspace.id } as const;
    const keys = ["a", "b", "c", "d"];
    await Promise.all(
      clients.map((client) =>
        client.setOrderTargets({
          expectedRevision: 0,
          workspaces: [{ workspaceId: workspace.id, targets: keys }],
        }),
      ),
    );
    const replica = new OrderReplica({
      membership: () => "all",
      port: desktop!,
      apply: () => {},
      failed: (error) => errors.push(error),
    });
    replica.snapshot((await desktop!.listOrders()).records);
    replica.reorder({ scope, move: createOrderMove({ moved: "d", order: ["a", "d", "b", "c"] }) });
    await expect
      .poll(async () => applySharedOrder(keys, (await mobile!.listOrders()).records[0]!.order))
      .toEqual(["a", "d", "b", "c"]);
    const second = await desktop!.createWorkspace({
      source: { kind: "directory", path: cwd, projectId: workspace.projectId },
    });
    const raceScope = { kind: "workspaces", projectId: workspace.projectId } as const;
    const a = workspace.id;
    const b = second.workspace!.id;
    const extra: string[] = [];
    for (let index = 0; index < 2; index++) {
      const next = await desktop!.createWorkspace({
        source: { kind: "directory", path: cwd, projectId: workspace.projectId },
      });
      extra.push(next.workspace!.id);
    }
    const c = extra[0]!;
    const d = extra[1]!;
    const attempts: number[][] = [[], []];
    const replicas = clients.map(
      (client, index) =>
        new OrderReplica({
          membership: () => "all",
          port: {
            setOrder: (input) => {
              attempts[index]!.push(input.expectedRevision);
              return client.setOrder(input);
            },
          },
          apply: () => {},
          failed: (error) => errors.push(error),
        }),
    );
    for (const peer of replicas) peer.snapshot([]);
    replicas[0]!.reorder({
      scope: raceScope,
      move: createOrderMove({ moved: d, order: [a, d, b, c] }),
    });
    replicas[1]!.reorder({
      scope: raceScope,
      move: createOrderMove({ moved: c, order: [c, a, b, d] }),
    });
    await expect.poll(() => attempts.flat().filter((revision) => revision === 1).length).toBe(1);
    await expect
      .poll(
        async () =>
          (await desktop!.listOrders()).records.find((record) => record.scope.kind === "workspaces")
            ?.revision,
      )
      .toBe(2);
    const desktopRecord = (await desktop!.listOrders()).records;
    expect(desktopRecord.find((record) => record.scope.kind === "workspaces")?.order).toEqual([
      c,
      a,
      d,
      b,
    ]);
    expect((await mobile!.listOrders()).records).toEqual(desktopRecord);
    expect(attempts.map((values) => values[0])).toEqual([0, 0]);
    expect(errors).toEqual([]);
    await desktop!.removeProject(workspace.projectId);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await daemon.close();
  }
}, 60000);

test.each(["unpin", "archive"] as const)(
  "offline pinned %s uses fresh membership, retains valid moves and accepts the next gesture",
  async (removal) => {
    const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const desktop = new DaemonClient({ url, clientId: "pin-desktop", appVersion: "0.11.2" });
    let mobile = new DaemonClient({ url, clientId: "pin-mobile", appVersion: "0.11.2" });
    const errors: unknown[] = [];
    const writes: string[][] = [];
    let membership: OrderMembership = "pending";
    try {
      await Promise.all([desktop.connect(), mobile.connect()]);
      const cwd = join(daemon.paseoHome, "offline-pins");
      await mkdir(cwd);
      const first = await desktop.createWorkspace({ source: { kind: "directory", path: cwd } });
      const projectId = first.workspace!.projectId;
      const ids = [first.workspace!.id];
      for (let index = 0; index < 2; index++) {
        const next = await desktop.createWorkspace({
          source: { kind: "directory", path: cwd, projectId },
        });
        ids.push(next.workspace!.id);
      }
      const [a, b, c] = ids;
      for (const id of ids) await desktop.setWorkspacePinned(id, true);
      const scope = { kind: "pinned" } as const;
      await desktop.setOrder({ scope, expectedRevision: 0, order: [b!, a!, c!] });
      const replica = new OrderReplica({
        port: {
          setOrder: (input) => {
            writes.push(input.order);
            return mobile.setOrder(input);
          },
        },
        membership: () => membership,
        apply: () => {},
        failed: (error) => errors.push(error),
      });
      replica.snapshot((await mobile.listOrders()).records);
      replica.pause();
      await mobile.close();
      replica.reorder({ scope, move: createOrderMove({ moved: a!, order: [a!, b!, c!] }) });
      replica.reorder({ scope, move: createOrderMove({ moved: c!, order: [a!, c!, b!] }) });
      if (removal === "unpin") await desktop.setWorkspacePinned(a!, false);
      else await desktop.archiveWorkspace(a!);
      await expect
        .poll(
          async () =>
            (await desktop.listOrders()).records.find((record) => record.scope.kind === "pinned")
              ?.order,
        )
        .toEqual([b, c]);
      mobile = new DaemonClient({ url, clientId: "pin-mobile", appVersion: "0.11.2" });
      await mobile.connect();
      replica.snapshot((await mobile.listOrders()).records);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
      const directory = await mobile.fetchWorkspaces({});
      membership = new Set(
        directory.entries
          .filter((workspace) => workspace.pinnedAt)
          .map((workspace) => workspace.id),
      );
      replica.retry();
      await expect
        .poll(
          async () =>
            (await desktop.listOrders()).records.find((record) => record.scope.kind === "pinned")
              ?.order,
        )
        .toEqual([c, b]);
      expect(writes).toEqual([[c, b]]);
      expect(errors).toHaveLength(1);
      replica.reorder({ scope, move: createOrderMove({ moved: b!, order: [b!, c!] }) });
      await expect
        .poll(
          async () =>
            (await desktop.listOrders()).records.find((record) => record.scope.kind === "pinned")
              ?.order,
        )
        .toEqual([b, c]);
      expect(writes).toEqual([
        [c, b],
        [b, c],
      ]);
      expect(errors).toHaveLength(1);
      await desktop.removeProject(projectId);
    } finally {
      await Promise.all([desktop.close(), mobile.close()]);
      await daemon.close();
    }
  },
  60000,
);
