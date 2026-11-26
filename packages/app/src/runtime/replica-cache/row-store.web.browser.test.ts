import { expect, it } from "vitest";
import { createIndexedDbReplicaRowStore } from "./row-store.web";
import { REPLICA_SINGLETON_ROW_ID, type ReplicaRow } from "./row-store";

it("rejects directory deltas from a connection whose shared baseline was evicted", async () => {
  const databaseName = `replica-eviction-${crypto.randomUUID()}`;
  const first = createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 });
  const second = createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 });
  const serverId = "host";
  const kinds = ["agent", "checkpoint", "project", "workspace"] as const;
  const checkpoint: ReplicaRow = {
    serverId,
    kind: "checkpoint",
    id: REPLICA_SINGLETON_ROW_ID,
    payload: "checkpoint",
  };
  const project: ReplicaRow = { serverId, kind: "project", id: "project", payload: "project" };
  const workspace: ReplicaRow = {
    serverId,
    kind: "workspace",
    id: "workspace",
    payload: "workspace",
  };
  const timeline: ReplicaRow = { serverId, kind: "timeline", id: "agent", payload: "timeline" };
  const replace = { directoryBaselines: new Set([serverId]) };
  const delta = {
    upserts: [checkpoint, { ...workspace, payload: "updated workspace" }, timeline],
    deletes: [],
  };

  const incremental = { directoryBaselines: new Set<string>() };
  const baseline = { upserts: [checkpoint, project, workspace], deletes: [] };
  await first.open();
  await second.open();
  await first.apply(baseline, replace);
  expect(await second.read(serverId, kinds)).toEqual([checkpoint, project, workspace]);
  await second.apply(delta, incremental);
  expect(await first.read(serverId, kinds)).toEqual([checkpoint, project, delta.upserts[1]]);

  await first.deleteHost(serverId);
  await second.apply(delta, incremental);
  expect(await first.read(serverId, kinds)).toEqual([]);
  expect(await first.read(serverId, ["timeline"])).toEqual([timeline]);

  await first.apply(baseline, replace);
  await second.apply(delta, incremental);
  expect(await first.read(serverId, kinds)).toEqual([checkpoint, project, workspace]);
});
