import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, hash } from "./live-support.mjs";

const identityKeys = ["id", "name", "owner", "sandboxName", "teamId", "projectId"];

// Each content-addressed file is immutable; the journal points to its latest union.
export function cleanupLedger(directory, owned, checkpoint) {
  function read() {
    assert.match(owned.cleanupHash ?? "", /^[a-f0-9]{64}$/);
    const bytes = readFileSync(join(directory, `cleanup-${owned.cleanupHash}.json`));
    assert.equal(hash(bytes), owned.cleanupHash, "Cleanup checkpoint changed");
    const state = JSON.parse(bytes);
    for (const key of identityKeys) assert.equal(state[key], owned[key], `Cleanup ${key} changed`);
    return state;
  }
  function persist(state) {
    const previous = owned.cleanupHash ? read() : { sessionIds: [], snapshots: [] };
    const next = {};
    for (const key of identityKeys) {
      assert.ok(typeof owned[key] === "string" && owned[key]);
      assert.equal(state[key], owned[key], `Cleanup ${key} changed`);
      next[key] = owned[key];
    }
    next.sessionIds = [...new Set([...previous.sessionIds, ...state.sessionIds])].sort();
    const snapshots = new Map();
    for (const item of [...previous.snapshots, ...state.snapshots]) {
      assert.ok(
        item.id && next.sessionIds.includes(item.sourceSessionId),
        "Snapshot lacks verified session provenance",
      );
      const prior = snapshots.get(item.id);
      assert.ok(
        !prior || prior.sourceSessionId === item.sourceSessionId,
        "Snapshot provenance changed",
      );
      snapshots.set(item.id, { id: item.id, sourceSessionId: item.sourceSessionId });
    }
    next.snapshots = [...snapshots.values()].sort((a, b) => a.id.localeCompare(b.id));
    next.snapshotIds = next.snapshots.map((item) => item.id);
    const digest = hash(JSON.stringify(next, null, 2) + "\n");
    const path = join(directory, `cleanup-${digest}.json`);
    if (existsSync(path))
      assert.equal(hash(readFileSync(path)), digest, "Cleanup checkpoint changed");
    else atomicJson(path, next, "MISSING");
    owned.cleanupHash = digest;
    checkpoint();
  }
  return { read, persist };
}

export async function discoverCleanup(creds, ledger, lifecycle) {
  const state = ledger.read();
  try {
    // getSandbox verifies name/tags before discovery, without resuming the VM.
    const sandbox = await lifecycle.getSandbox(creds, state, false);
    await lifecycle.collectOwnedSnapshotCleanup(sandbox, state);
    ledger.persist(state);
  } catch (error) {
    if (!lifecycle.isNotFound(error)) throw error;
  }
  return state;
}

export function hasCleanupProvenance(local, verified) {
  const sameSet = (a, b) =>
    new Set(a).size === new Set(b).size && a.every((value) => b.includes(value));
  if (
    !Array.isArray(local.sessionIds) ||
    !Array.isArray(local.snapshots) ||
    !Array.isArray(local.snapshotIds)
  )
    return false;
  if (!local.snapshots.every((item) => item?.id && item?.sourceSessionId)) return false;
  const records = (values) => values.map((item) => JSON.stringify([item.id, item.sourceSessionId]));
  return (
    sameSet(local.sessionIds, verified.sessionIds) &&
    sameSet(local.snapshotIds, verified.snapshotIds) &&
    sameSet(records(local.snapshots), records(verified.snapshots))
  );
}

export async function cleanupFromLedger(creds, ledger, lifecycle) {
  const state = await discoverCleanup(creds, ledger, lifecycle);
  // No local session path is accessed or replaced; persist runs before deletion.
  return lifecycle.destroySandboxAndSnapshots(creds, state, ledger.persist);
}
