import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { InactiveOrderScopeError, OrderingService } from "./index.js";
import { createOrderingRuntime } from "./runtime.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function service(write?: (path: string, value: unknown) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "paseo-order-"));
  homes.push(home);
  const ordering = new OrderingService({
    filePath: join(home, "order.json"),
    validate: async () => {},
    write,
  });
  await ordering.initialize();
  return { ordering, home };
}
const workspaceScope = { kind: "workspaces", projectId: "p" } as const;
test("persists a reorder and rejects a stale second client without publishing it", async () => {
  const { ordering, home } = await service();
  const updates: unknown[] = [];
  const subscription = ordering.subscribe({
    principalId: "owner",
    listener: (change) => updates.push(change),
  });
  expect(subscription.records).toEqual([]);
  expect(
    await ordering.set({
      principalId: "owner",
      scope: workspaceScope,
      expectedRevision: 0,
      order: ["b", "a"],
    }),
  ).toEqual({
    accepted: true,
    record: { scope: workspaceScope, revision: 1, order: ["b", "a"] },
  });
  expect(
    await ordering.set({
      principalId: "owner",
      scope: workspaceScope,
      expectedRevision: 0,
      order: ["a", "b"],
    }),
  ).toEqual({
    accepted: false,
    record: { scope: workspaceScope, revision: 1, order: ["b", "a"] },
  });
  expect(updates).toHaveLength(1);
  const restarted = new OrderingService({
    filePath: join(home, "order.json"),
    validate: async () => {},
  });
  await restarted.initialize();
  expect(restarted.list("owner")).toEqual([
    { scope: workspaceScope, revision: 1, order: ["b", "a"] },
  ]);
  subscription.unsubscribe();
  await ordering.set({
    principalId: "owner",
    scope: workspaceScope,
    expectedRevision: 1,
    order: ["a", "b"],
  });
  expect(updates).toHaveLength(1);
});
test("serializes concurrent writes and keeps independent scopes independent", async () => {
  const { ordering } = await service();
  await ordering.setTargets({
    device: ordering.lease({ principalId: "owner", clientId: "test" }),
    expectedRevision: 0,
    workspaces: [{ workspaceId: "w", targets: ["agent_a"] }],
  });
  const results = await Promise.all([
    ordering.set({
      principalId: "owner",
      scope: workspaceScope,
      expectedRevision: 0,
      order: ["a"],
    }),
    ordering.set({
      principalId: "owner",
      scope: workspaceScope,
      expectedRevision: 0,
      order: ["b"],
    }),
    ordering.set({
      principalId: "owner",
      scope: { kind: "tabs", workspaceId: "w" },
      expectedRevision: 0,
      order: ["agent_a"],
    }),
  ]);
  expect(results.map((result) => result.accepted)).toEqual([true, false, true]);
});
test("failed persistence changes neither authority nor subscriber state", async () => {
  const { ordering } = await service(async () => {
    throw new Error("disk full");
  });
  const updates: unknown[] = [];
  ordering.subscribe({ principalId: "owner", listener: (change) => updates.push(change) });
  await expect(
    ordering.set({
      principalId: "owner",
      scope: workspaceScope,
      expectedRevision: 0,
      order: ["a"],
    }),
  ).rejects.toThrow("disk full");
  expect(ordering.list("owner")).toEqual([]);
  expect(updates).toEqual([]);
});
test("prunes archived resources and removes their tab records", async () => {
  const { ordering } = await service();
  await ordering.set({
    principalId: "owner",
    scope: workspaceScope,
    expectedRevision: 0,
    order: ["b", "a", "c"],
  });
  await ordering.setTargets({
    device: ordering.lease({ principalId: "owner", clientId: "test" }),
    expectedRevision: 0,
    workspaces: [{ workspaceId: "b", targets: ["agent_a"] }],
  });
  await ordering.set({
    principalId: "owner",
    scope: { kind: "tabs", workspaceId: "b" },
    expectedRevision: 0,
    order: ["agent_a"],
  });
  await ordering.prune({
    load: async () => ({
      projectIds: new Set(["p"]),
      workspaceIds: new Set(["a", "c"]),
      pinnedWorkspaceIds: new Set(),
    }),
  });
  expect(ordering.list("owner")).toEqual([
    { scope: workspaceScope, revision: 2, order: ["a", "c"] },
  ]);
});

test("queued prune loads current pins after preceding writes and prunes them in one revision", async () => {
  const { ordering } = await service();
  const scope = { kind: "pinned" } as const;
  await ordering.set({ principalId: "owner", scope, expectedRevision: 0, order: ["a", "b", "c"] });
  let pinned = new Set(["a"]);
  const write = ordering.set({
    principalId: "owner",
    scope,
    expectedRevision: 1,
    order: ["b", "a", "c"],
  });
  const prune = ordering.prune({
    load: async () => ({
      projectIds: new Set(["p"]),
      workspaceIds: new Set(["a", "b", "c"]),
      pinnedWorkspaceIds: pinned,
    }),
  });
  pinned = new Set(["a", "b"]);
  await write;
  await prune;
  expect(ordering.list("owner")).toEqual([{ scope, revision: 3, order: ["b", "a"] }]);
});
test("offline inventories survive reload; last holder removal and forget fence stale sources", async () => {
  const { ordering, home } = await service();
  const a = ordering.lease({ principalId: "owner", clientId: "a" });
  const b = ordering.lease({ principalId: "owner", clientId: "b" });
  const scope = { kind: "tabs", workspaceId: "w" } as const;
  const workspaces = [{ workspaceId: "w", targets: ["file_readme", "browser_1"] }];
  await ordering.setTargets({ device: a, expectedRevision: 0, workspaces });
  await ordering.setTargets({ device: b, expectedRevision: 0, workspaces });
  await ordering.set({
    principalId: "owner",
    device: a,
    scope,
    expectedRevision: 0,
    order: ["browser_1", "file_readme"],
  });
  await ordering.setTargets({ device: a, expectedRevision: 1, workspaces: [] });
  const reloaded = new OrderingService({
    filePath: join(home, "order.json"),
    validate: async () => {},
  });
  await reloaded.initialize();
  expect(reloaded.list("owner")).toEqual([
    { scope, revision: 1, order: ["browser_1", "file_readme"] },
  ]);
  await reloaded.forgetDevice({ principalId: "other", clientId: "b" });
  expect(reloaded.list("owner")[0]!.order).toEqual(["browser_1", "file_readme"]);
  await reloaded.forgetDevice(b);
  expect(reloaded.list("owner")).toEqual([{ scope, revision: 2, order: [] }]);
  await expect(reloaded.setTargets({ device: b, expectedRevision: 1, workspaces })).rejects.toThrow(
    "forgotten",
  );
  await expect(
    reloaded.set({
      principalId: "owner",
      device: b,
      scope,
      expectedRevision: 2,
      order: ["file_readme"],
    }),
  ).rejects.toThrow("forgotten");
  await reloaded.setTargets({ device: reloaded.lease(b), expectedRevision: 2, workspaces });
  expect(reloaded.deviceRevision(b)).toBe(3);
});
test("closing the last targets cannot be undone by a stale ordering write", async () => {
  const { ordering } = await service();
  const device = ordering.lease({ principalId: "owner", clientId: "a" });
  const scope = { kind: "tabs", workspaceId: "w" } as const;
  await ordering.setTargets({
    device,
    expectedRevision: 0,
    workspaces: [{ workspaceId: "w", targets: ["file_x"] }],
  });
  await ordering.set({
    principalId: "owner",
    device,
    scope,
    expectedRevision: 0,
    order: ["file_x"],
  });
  await ordering.setTargets({ device, expectedRevision: 1, workspaces: [] });
  const stale = await ordering.set({
    principalId: "owner",
    device,
    scope,
    expectedRevision: 1,
    order: ["file_x"],
  });
  expect(stale).toEqual({ accepted: false, record: { scope, revision: 2, order: [] } });
  const replay = await ordering.set({
    principalId: "owner",
    device,
    scope,
    expectedRevision: 2,
    order: ["file_x"],
  });
  expect(replay.record.order).toEqual([]);
});

test("shared clientId sources preserve open targets across CAS retries until detached", async () => {
  const { ordering } = await service();
  const page1 = ordering.lease({ principalId: "owner", clientId: "shared-profile" });
  const page2 = ordering.lease({ principalId: "owner", clientId: "shared-profile" });
  const scope = { kind: "tabs", workspaceId: "w" } as const;
  await ordering.setTargets({
    device: page1,
    expectedRevision: 0,
    workspaces: [{ workspaceId: "w", targets: ["file_open", "agent_a"] }],
  });
  await ordering.set({
    principalId: "owner",
    device: page1,
    scope,
    expectedRevision: 0,
    order: ["file_open", "agent_a"],
  });
  expect(
    await ordering.setTargets({
      device: page2,
      expectedRevision: 0,
      workspaces: [{ workspaceId: "w", targets: ["agent_a"] }],
    }),
  ).toEqual({ accepted: false, revision: 1 });
  expect(
    await ordering.setTargets({
      device: page2,
      expectedRevision: 1,
      workspaces: [{ workspaceId: "w", targets: ["agent_a", "browser_2"] }],
    }),
  ).toEqual({ accepted: true, revision: 2 });
  expect(ordering.list("owner")).toEqual([{ scope, revision: 1, order: ["file_open", "agent_a"] }]);
  ordering.releaseSource(page1);
  await ordering.setTargets({
    device: page2,
    expectedRevision: 2,
    workspaces: [{ workspaceId: "w", targets: ["agent_a"] }],
  });
  expect(ordering.list("owner")).toEqual([{ scope, revision: 2, order: ["agent_a"] }]);
});

test("setTargets skips archived or unknown workspaces and dedupes repeated workspaceIds", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-order-"));
  homes.push(home);
  const ordering = new OrderingService({
    filePath: join(home, "order.json"),
    validate: async ({ scope }) => {
      if (scope.kind === "tabs" && scope.workspaceId === "archived") {
        throw new InactiveOrderScopeError("Workspace is not active");
      }
    },
  });
  await ordering.initialize();
  const device = ordering.lease({ principalId: "owner", clientId: "desktop" });
  await expect(
    ordering.setTargets({
      device,
      expectedRevision: 0,
      workspaces: [
        { workspaceId: "archived", targets: ["file_old"] },
        { workspaceId: "active", targets: ["file_a"] },
        { workspaceId: "active", targets: ["file_a", "browser_1"] },
      ],
    }),
  ).resolves.toEqual({ accepted: true, revision: 1 });
  expect(
    await ordering.set({
      principalId: "owner",
      device,
      scope: { kind: "tabs", workspaceId: "active" },
      expectedRevision: 0,
      order: ["browser_1", "file_a"],
    }),
  ).toEqual({
    accepted: true,
    record: {
      scope: { kind: "tabs", workspaceId: "active" },
      revision: 1,
      order: ["browser_1", "file_a"],
    },
  });
});

test("initialize moves corrupt ordering files aside and starts empty", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-order-corrupt-"));
  homes.push(home);
  const filePath = join(home, "ui-order.json");
  await writeFile(filePath, "{not valid json", "utf8");
  const error = vi.fn();
  const ordering = new OrderingService({
    filePath,
    validate: async () => {},
    logger: { error },
  });
  await ordering.initialize();
  expect(ordering.list("owner")).toEqual([]);
  expect(error).toHaveBeenCalledTimes(1);
  const files = await readdir(home);
  expect(files.some((name) => name.startsWith("ui-order.json.corrupt-"))).toBe(true);
});

test("forgetDevice ignores unregistered clients and evicts old forgotten tombstones", async () => {
  const { ordering, home } = await service();
  const filePath = join(home, "order.json");
  await ordering.forgetDevice({ principalId: "owner", clientId: "never-seen" });
  expect(
    await readFile(filePath, "utf8").then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  for (let i = 0; i < 40; i++) {
    const lease = ordering.lease({ principalId: "owner", clientId: `client-${i}` });
    await ordering.setTargets({
      device: lease,
      expectedRevision: 0,
      workspaces: [{ workspaceId: "w", targets: ["file_a"] }],
    });
    await ordering.forgetDevice({ principalId: "owner", clientId: `client-${i}` });
  }
  const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
    devices: Array<{ clientId: string }>;
  };
  expect(persisted.devices.length).toBeLessThanOrEqual(32);
});

test("createOrderingRuntime coalesces registry mutations into async prune without blocking notifyMutation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-order-runtime-"));
  homes.push(home);
  await mkdir(join(home, "projects"), { recursive: true });
  let workspaceListener:
    | ((mutation: {
        kind: "upsert" | "archive" | "remove";
        workspaceId: string;
        workspace: null;
      }) => void | Promise<void>)
    | undefined;
  let active = ["w1", "w2", "w3"];
  let listCalls = 0;
  const runtime = await createOrderingRuntime({
    paseoHome: home,
    projects: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [
        { projectId: "p", path: home, updatedAt: "2026-01-01", archivedAt: undefined },
      ],
      get: async () => ({
        projectId: "p",
        path: home,
        updatedAt: "2026-01-01",
        archivedAt: undefined,
      }),
      upsert: async () => {},
      update: async () => null,
      archive: async () => {},
      remove: async () => {},
      subscribeToMutations: () => () => {},
    },
    workspaces: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      listAll: async () => {
        listCalls++;
        return active.map((id) => ({
          workspaceId: id,
          projectId: "p",
          directoryPath: home,
          updatedAt: "2026-01-01",
        }));
      },
      listActive: async () => [],
      get: async () => null,
      update: async () => null,
      upsert: async () => {},
      archive: async () => true,
      remove: async () => {},
      commitWorkspaceLabelMutation: async () => {
        throw new Error("unused");
      },
      subscribeToMutations: (listener) => {
        workspaceListener = listener as typeof workspaceListener;
        return () => {};
      },
    } as never,
    logger: { error: vi.fn() } as never,
  });
  try {
    await runtime.service.set({
      principalId: "owner",
      scope: { kind: "workspaces", projectId: "p" },
      expectedRevision: 0,
      order: ["w1", "w2", "w3"],
    });
    const baselineCalls = listCalls;
    active = ["w3"];
    const r1 = workspaceListener!({ kind: "archive", workspaceId: "w1", workspace: null });
    const r2 = workspaceListener!({ kind: "archive", workspaceId: "w2", workspace: null });
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    await expect.poll(() => runtime.service.list("owner")[0]?.order).toEqual(["w3"]);
    expect(listCalls - baselineCalls).toBe(1);
  } finally {
    runtime.dispose();
  }
});
