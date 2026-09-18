import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupLedger,
  cleanupFromLedger,
  hasCleanupProvenance,
} from "../scripts/live-cleanup.mjs";
import * as lifecycle from "../dist/lifecycle.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "paseo-runner-cleanup-"));
  const owned = {
    id: randomUUID(),
    name: "owned-name",
    sandboxName: "owned-name",
    owner: "owner-a",
    teamId: "team_x",
    projectId: "prj_x",
  };
  const ledger = cleanupLedger(directory, owned, () => {});
  ledger.persist({
    ...owned,
    sessionIds: [],
    snapshots: [],
    pairingUrl: "never-copy",
    logs: ["never-copy"],
  });
  return { directory, owned, ledger };
}

function transport(
  ledger,
  { absent = false, owner = "owner-a", source = "session-one", failSnapshotDelete = false } = {},
) {
  const calls = [];
  const meta = {
    name: "owned-name",
    persistent: true,
    createdAt: 1000,
    updatedAt: 1000,
    currentSessionId: "session-one",
    status: "running",
    tags: { owner, paseoSandbox: "owned-name" },
  };
  const session = {
    id: "session-one",
    memory: 1024,
    vcpus: 1,
    region: "iad1",
    timeout: 60000,
    status: "running",
    requestedAt: 1000,
    createdAt: 1000,
    cwd: "/vercel/workspace",
    updatedAt: 1000,
  };
  let snapshotDeleted = false;
  const snapshot = () => ({
    id: "snap-one",
    sourceSessionId: source,
    region: "iad1",
    status: snapshotDeleted ? "deleted" : "created",
    sizeBytes: 1,
    createdAt: 1000,
    updatedAt: 1000,
  });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const missing = () => json({ error: { code: "not_found", message: "not found" } }, 404);
  const creds = {
    token: "fake-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url, init) => {
      const parsed = new URL(url),
        path = parsed.pathname;
      calls.push({ method: init.method, path, resume: parsed.searchParams.get("resume") });
      if (path === "/api/v2/sandboxes/owned-name") {
        if (init.method === "GET")
          return absent ? missing() : json({ sandbox: meta, session, routes: [], resumed: false });
        if (init.method === "DELETE") {
          assert.deepEqual(ledger.read().snapshots, [
            { id: "snap-one", sourceSessionId: "session-one" },
          ]);
          absent = true;
          return json({ sandbox: meta });
        }
      }
      if (path === "/api/v2/sandboxes/sessions")
        return json({ sessions: [session], pagination: { count: 1, next: null } });
      if (path === "/api/v2/sandboxes/snapshots")
        return json({
          snapshots: snapshotDeleted ? [] : [snapshot()],
          pagination: { count: 1, next: null },
        });
      if (path === "/api/v2/sandboxes/snapshots/snap-one") {
        if (init.method === "DELETE") {
          if (failSnapshotDelete)
            return json(
              { error: { code: "bad_request", message: "injected snapshot deletion failure" } },
              400,
            );
          snapshotDeleted = true;
        }
        return json({ snapshot: snapshot() });
      }
      throw new Error(`Unexpected fake request ${init.method} ${path}`);
    },
  };
  return {
    creds,
    calls,
    retry() {
      failSnapshotDelete = false;
    },
  };
}

test("cleanup identity is immutable, nonsecret and retains snapshot retry provenance", () => {
  const f = fixture();
  try {
    const originalHash = f.owned.cleanupHash;
    const original = readFileSync(join(f.directory, `cleanup-${originalHash}.json`));
    assert.ok(!original.toString().includes("never-copy"));
    f.ledger.persist({
      ...f.owned,
      sessionIds: ["session-one"],
      snapshots: [{ id: "snap-one", sourceSessionId: "session-one" }],
    });
    assert.deepEqual(readFileSync(join(f.directory, `cleanup-${originalHash}.json`)), original);
    f.ledger.persist({ ...f.ledger.read(), snapshots: [] });
    assert.equal(f.ledger.read().snapshots.length, 1, "deletion cannot erase retry provenance");
    assert.throws(
      () => f.ledger.persist({ ...f.ledger.read(), owner: "foreign" }),
      /owner changed/,
    );
    assert.throws(
      () =>
        f.ledger.persist({
          ...f.ledger.read(),
          snapshots: [{ id: "other", sourceSessionId: "unverified" }],
        }),
      /provenance/,
    );
    assert.ok(
      !hasCleanupProvenance(
        { sessionIds: ["foreign"], snapshots: [], snapshotIds: [] },
        f.ledger.read(),
      ),
    );
    assert.ok(hasCleanupProvenance(f.ledger.read(), f.ledger.read()));
    assert.equal(
      hasCleanupProvenance({ sessionIds: [], snapshots: [null], snapshotIds: [] }, f.ledger.read()),
      false,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("fallback preserves corrupt state and retries snapshots after VM deletion with missing state", async () => {
  const f = fixture();
  try {
    const local = join(f.directory, "corrupt-session.json");
    writeFileSync(local, "{corrupt-private-state");
    const fake = transport(f.ledger, { failSnapshotDelete: true });
    await assert.rejects(
      cleanupFromLedger(fake.creds, f.ledger, lifecycle),
      /injected snapshot deletion failure/,
    );
    assert.equal(readFileSync(local, "utf8"), "{corrupt-private-state");
    assert.ok(
      fake.calls.some((call) => call.method === "DELETE" && call.path.endsWith("/owned-name")),
    );
    assert.equal(f.ledger.read().snapshots[0].sourceSessionId, "session-one");
    rmSync(local);
    fake.retry();
    const reopened = cleanupLedger(f.directory, structuredClone(f.owned), () => {});
    assert.deepEqual(await cleanupFromLedger(fake.creds, reopened, lifecycle), ["snap-one"]);
    assert.equal(existsSync(local), false);
    assert.ok(fake.calls.every((call) => call.resume !== "true"));
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("fallback refuses reused names and foreign snapshot source sessions without deleting them", async () => {
  const f = fixture();
  try {
    const foreignVm = transport(f.ledger, { owner: "foreign" });
    await assert.rejects(
      cleanupFromLedger(foreignVm.creds, f.ledger, lifecycle),
      /owner or name mismatch/,
    );
    assert.ok(foreignVm.calls.every((call) => call.method === "GET" && call.resume !== "true"));
    f.ledger.persist({
      ...f.owned,
      sessionIds: ["session-one"],
      snapshots: [{ id: "snap-one", sourceSessionId: "session-one" }],
    });
    const foreignSnapshot = transport(f.ledger, { absent: true, source: "foreign-session" });
    await assert.rejects(
      cleanupFromLedger(foreignSnapshot.creds, f.ledger, lifecycle),
      /no verified provenance/,
    );
    assert.ok(foreignSnapshot.calls.every((call) => call.method === "GET"));
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("empty local provenance cannot hide a snapshot retained in the cleanup ledger", async () => {
  const f = fixture();
  try {
    f.ledger.persist({
      ...f.owned,
      sessionIds: ["session-one"],
      snapshots: [{ id: "snap-one", sourceSessionId: "session-one" }],
    });
    const local = { sessionIds: [], snapshots: [], snapshotIds: [] };
    assert.equal(hasCleanupProvenance(local, f.ledger.read()), false);
    const fake = transport(f.ledger, { absent: true });
    assert.deepEqual(await cleanupFromLedger(fake.creds, f.ledger, lifecycle), ["snap-one"]);
    assert.ok(
      fake.calls.some((call) => call.method === "DELETE" && call.path.endsWith("/snap-one")),
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
