import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { OrderingService } from "./index.js";

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
