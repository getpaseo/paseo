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
  const ordering = new OrderingService(join(home, "order.json"), async () => {}, write);
  await ordering.initialize();
  return { ordering, home };
}
const scope = { kind: "workspaces", projectId: "p" } as const;
test("persists a reorder and rejects a stale second client without publishing it", async () => {
  const { ordering, home } = await service();
  const updates: unknown[] = [];
  const subscription = ordering.subscribe((change) => updates.push(change));
  expect(subscription.records).toEqual([]);
  expect(await ordering.set({ scope, expectedRevision: 0, order: ["b", "a"] })).toEqual({
    accepted: true,
    record: { scope, revision: 1, order: ["b", "a"] },
  });
  expect(await ordering.set({ scope, expectedRevision: 0, order: ["a", "b"] })).toEqual({
    accepted: false,
    record: { scope, revision: 1, order: ["b", "a"] },
  });
  expect(updates).toHaveLength(1);
  const restarted = new OrderingService(join(home, "order.json"), async () => {});
  await restarted.initialize();
  expect(restarted.list()).toEqual([{ scope, revision: 1, order: ["b", "a"] }]);
  subscription.unsubscribe();
  await ordering.set({ scope, expectedRevision: 1, order: ["a", "b"] });
  expect(updates).toHaveLength(1);
});
test("serializes concurrent writes and keeps independent scopes independent", async () => {
  const { ordering } = await service();
  const results = await Promise.all([
    ordering.set({ scope, expectedRevision: 0, order: ["a"] }),
    ordering.set({ scope, expectedRevision: 0, order: ["b"] }),
    ordering.set({
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
  ordering.subscribe((change) => updates.push(change));
  await expect(ordering.set({ scope, expectedRevision: 0, order: ["a"] })).rejects.toThrow(
    "disk full",
  );
  expect(ordering.list()).toEqual([]);
  expect(updates).toEqual([]);
});
test("prunes archived resources and removes their tab records", async () => {
  const { ordering } = await service();
  await ordering.set({ scope, expectedRevision: 0, order: ["b", "a", "c"] });
  await ordering.set({
    scope: { kind: "tabs", workspaceId: "b" },
    expectedRevision: 0,
    order: ["agent_a"],
  });
  await ordering.prune({ projectIds: new Set(["p"]), workspaceIds: new Set(["a", "c"]) });
  expect(ordering.list()).toEqual([{ scope, revision: 2, order: ["a", "c"] }]);
});
