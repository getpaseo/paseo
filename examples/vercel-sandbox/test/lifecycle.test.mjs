import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";

const state = {
  id: randomUUID(),
  name: "same-name",
  createdAt: "",
  updatedAt: "",
  phase: "ready",
  sandboxName: "same-name",
  region: "iad1",
  image: "vercel/sandbox/node:24",
  teamId: "team_x",
  projectId: "prj_x",
  owner: "owner-a",
  paseoHome: "/vercel/paseo-home",
  workspacePath: "/vercel/workspace",
  repoPath: "/vercel/workspace/repo",
  agentProvider: "codex",
  agentModel: "openai/gpt-6-astra",
  sessionIds: [],
  snapshotIds: [],
  snapshots: [],
  logs: [],
};

const now = 1_000;
const session = (id) => ({
  id,
  memory: 1024,
  vcpus: 1,
  region: "iad1",
  timeout: 60_000,
  status: "running",
  requestedAt: now,
  createdAt: now,
  cwd: "/vercel/workspace",
  updatedAt: now,
});
const sandboxMetadata = (owner) => ({
  name: "same-name",
  persistent: true,
  createdAt: now,
  updatedAt: now,
  currentSessionId: "session-current",
  status: "running",
  tags: { owner, paseoSandbox: "same-name" },
});
const snapshotMetadata = (id, sourceSessionId, status = "created") => ({
  id,
  sourceSessionId,
  region: "iad1",
  status,
  sizeBytes: 1,
  createdAt: now,
  updatedAt: now,
});

function jsonResponse(url, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
    url,
  });
}

function notFound(url) {
  return jsonResponse(url, { error: { code: "not_found", message: "not found" } }, 404);
}

const {
  collectOwnedSnapshotCleanup,
  deleteVerifiedSnapshot,
  destroySandboxAndSnapshots,
  getSandbox,
  stopSandbox,
  resumeSandbox,
} = await import("../dist/lifecycle.js");

test("getSandbox verifies ownership before a requested resume", async () => {
  const calls = [];
  const creds = {
    token: "test-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push(`${init.method} ${parsed.pathname} ${parsed.searchParams.get("resume")}`);
      return jsonResponse(url, {
        sandbox: { ...sandboxMetadata("owner-a"), status: "stopped" },
        session: { ...session("session-current"), status: "stopped" },
        routes: [],
        resumed: false,
      });
    },
  };
  const originalRun = Sandbox.prototype.runCommand;
  const probes = [];
  Sandbox.prototype.runCommand = async function (cmd, args) {
    probes.push([cmd, args, this.tags.owner]);
    return { exitCode: 0 };
  };
  try {
    const sandbox = await getSandbox(creds, state, true);
    assert.equal(sandbox.name, "same-name");
    assert.deepEqual(calls, ["GET /api/v2/sandboxes/same-name false"]);
    assert.deepEqual(probes, [["true", [], "owner-a"]]);
    assert.deepEqual(state.sessionIds, ["session-current"]);
  } finally {
    Sandbox.prototype.runCommand = originalRun;
  }
});

test("same-name wrong-owner sandbox cannot act, even when resume was requested", async () => {
  const calls = [];
  const creds = {
    token: "test-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push(`${init.method} ${parsed.pathname} ${parsed.searchParams.get("resume")}`);
      return jsonResponse(url, {
        sandbox: sandboxMetadata("owner-b"),
        session: session("session-foreign"),
        routes: [],
        resumed: false,
      });
    },
  };
  await assert.rejects(() => getSandbox(creds, state, true), /sandbox owner or name mismatch/);
  assert.deepEqual(calls, ["GET /api/v2/sandboxes/same-name false"]);
});

test("snapshot discovery records provenance before sandbox deletion", async () => {
  const sessionState = structuredClone(state);
  sessionState.sessionIds = [];
  sessionState.snapshots = [];
  const sandbox = {
    listSessions: async function* () {
      yield session("session-current");
      yield session("session-old");
    },
    listSnapshots: async function* () {
      yield snapshotMetadata("snap-owned", "session-old");
    },
  };
  const records = await collectOwnedSnapshotCleanup(sandbox, sessionState);
  assert.deepEqual(records, [{ id: "snap-owned", sourceSessionId: "session-old" }]);
  assert.deepEqual(sessionState.sessionIds, ["session-current", "session-old"]);
});

test("stopSandbox binds the snapshot to the session that was stopped", async () => {
  const sandbox = {
    currentSession: () => ({ sessionId: "session-old" }),
    stop: async () => ({ snapshot: snapshotMetadata("snap-owned", "session-old") }),
  };
  const record = await stopSandbox(sandbox);
  assert.deepEqual(record, { id: "snap-owned", sourceSessionId: "session-old" });
});

test("foreign snapshot sourceSessionId is rejected", async () => {
  const sessionState = structuredClone(state);
  sessionState.sessionIds = ["session-current"];
  sessionState.snapshots = [];
  const sandbox = {
    listSessions: async function* () {
      yield session("session-current");
    },
    listSnapshots: async function* () {
      yield snapshotMetadata("snap-foreign", "session-foreign");
    },
  };
  await assert.rejects(
    () => collectOwnedSnapshotCleanup(sandbox, sessionState),
    /snapshot snap-foreign has no verified provenance/,
  );
});

test("destroy persists discovered snapshots before deleting the sandbox", async () => {
  const sessionState = structuredClone(state);
  sessionState.sessionIds = [];
  sessionState.snapshots = [];
  const events = [];
  let sandboxDeleted = false;
  const creds = {
    token: "test-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (init.method === "GET" && path === "/api/v2/sandboxes/same-name") {
        if (sandboxDeleted) return notFound(url);
        return jsonResponse(url, {
          sandbox: sandboxMetadata("owner-a"),
          session: session("session-current"),
          routes: [],
          resumed: false,
        });
      }
      if (init.method === "GET" && path === "/api/v2/sandboxes/sessions") {
        return jsonResponse(url, {
          sessions: [session("session-current"), session("session-old")],
          pagination: { count: 2, next: null },
        });
      }
      if (init.method === "GET" && path === "/api/v2/sandboxes/snapshots") {
        return jsonResponse(url, {
          snapshots: [snapshotMetadata("snap-owned", "session-old")],
          pagination: { count: 1, next: null },
        });
      }
      if (init.method === "DELETE" && path === "/api/v2/sandboxes/same-name") {
        sandboxDeleted = true;
        events.push("delete-sandbox");
        return jsonResponse(url, { sandbox: sandboxMetadata("owner-a") });
      }
      if (path === "/api/v2/sandboxes/snapshots/snap-owned") {
        if (init.method === "DELETE") {
          events.push("delete-snapshot");
          return jsonResponse(url, {
            snapshot: snapshotMetadata("snap-owned", "session-old", "deleted"),
          });
        }
        return jsonResponse(url, {
          snapshot: snapshotMetadata("snap-owned", "session-old", "deleted"),
        });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
  };
  const persisted = [];
  const deleted = await destroySandboxAndSnapshots(creds, sessionState, (value) => {
    events.push("persist");
    persisted.push(structuredClone(value));
  });
  assert.deepEqual(deleted, ["snap-owned"]);
  assert.ok(events.indexOf("persist") < events.indexOf("delete-sandbox"));
  assert.deepEqual(persisted[0].snapshots, [{ id: "snap-owned", sourceSessionId: "session-old" }]);
  assert.deepEqual(persisted[0].sessionIds, ["session-current", "session-old"]);
});

test("snapshot deletion failure preserves state and retry succeeds without rediscovery", async () => {
  const sessionState = structuredClone(state);
  sessionState.sessionIds = ["session-old"];
  sessionState.snapshots = [{ id: "snap-owned", sourceSessionId: "session-old" }];
  let snapshotDeleteFails = true;
  let snapshotDeleted = false;
  const calls = [];
  const creds = {
    token: "test-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push(`${init.method} ${parsed.pathname}`);
      if (init.method === "GET" && parsed.pathname === "/api/v2/sandboxes/same-name")
        return notFound(url);
      if (parsed.pathname === "/api/v2/sandboxes/snapshots/snap-owned") {
        if (init.method === "DELETE" && snapshotDeleteFails) {
          return jsonResponse(
            url,
            { error: { code: "internal_server_error", message: "temporary failure" } },
            500,
          );
        }
        if (init.method === "DELETE") snapshotDeleted = true;
        return jsonResponse(url, {
          snapshot: snapshotMetadata(
            "snap-owned",
            "session-old",
            snapshotDeleted ? "deleted" : "created",
          ),
        });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
  };
  const persisted = [];
  const persist = (value) => persisted.push(structuredClone(value));
  await assert.rejects(
    () => destroySandboxAndSnapshots(creds, sessionState, persist),
    /temporary failure/,
  );
  assert.deepEqual(persisted.at(-1).snapshots, [
    { id: "snap-owned", sourceSessionId: "session-old" },
  ]);
  const discoveryCalls = calls.filter((call) => call === "GET /v2/sandboxes/snapshots").length;
  assert.equal(discoveryCalls, 0);
  snapshotDeleteFails = false;
  calls.length = 0;
  const deleted = await destroySandboxAndSnapshots(creds, sessionState, persist);
  assert.deepEqual(deleted, ["snap-owned"]);
  assert.equal(calls.filter((call) => call === "GET /v2/sandboxes/snapshots").length, 0);
});

test("name reuse after cleanup is refused", async () => {
  let snapshotDeleted = false;
  const sessionState = structuredClone(state);
  sessionState.sessionIds = ["session-old"];
  sessionState.snapshots = [{ id: "snap-owned", sourceSessionId: "session-old" }];
  let sandboxDeleted = false;
  const creds = {
    token: "test-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === "GET" && parsed.pathname === "/api/v2/sandboxes/same-name") {
        if (!sandboxDeleted) {
          sandboxDeleted = true;
          return jsonResponse(url, {
            sandbox: sandboxMetadata("owner-a"),
            session: session("session-old"),
            routes: [],
            resumed: false,
          });
        }
        return jsonResponse(url, {
          sandbox: sandboxMetadata("owner-b"),
          session: session("session-replacement"),
          routes: [],
          resumed: false,
        });
      }
      if (init.method === "GET" && parsed.pathname === "/api/v2/sandboxes/sessions") {
        return jsonResponse(url, {
          sessions: [session("session-old")],
          pagination: { count: 1, next: null },
        });
      }
      if (init.method === "GET" && parsed.pathname === "/api/v2/sandboxes/snapshots") {
        return jsonResponse(url, {
          snapshots: [snapshotMetadata("snap-owned", "session-old")],
          pagination: { count: 1, next: null },
        });
      }
      if (init.method === "DELETE" && parsed.pathname === "/api/v2/sandboxes/same-name") {
        return jsonResponse(url, { sandbox: sandboxMetadata("owner-a") });
      }
      if (parsed.pathname === "/api/v2/sandboxes/snapshots/snap-owned") {
        if (init.method === "DELETE") snapshotDeleted = true;
        return jsonResponse(url, {
          snapshot: snapshotMetadata(
            "snap-owned",
            "session-old",
            snapshotDeleted ? "deleted" : "created",
          ),
        });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
  };
  await assert.rejects(
    () => destroySandboxAndSnapshots(creds, sessionState, () => {}),
    /sandbox owner or name mismatch/,
  );
});

test("deleteVerifiedSnapshot rejects a foreign sourceSessionId", async () => {
  const sessionState = structuredClone(state);
  sessionState.sessionIds = ["session-current"];
  const calls = [];
  const creds = {
    token: "test-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push(`${init.method} ${parsed.pathname}`);
      return jsonResponse(url, { snapshot: snapshotMetadata("snap-owned", "session-old") });
    },
  };
  await assert.rejects(
    () =>
      deleteVerifiedSnapshot(creds, sessionState, {
        id: "snap-owned",
        sourceSessionId: "session-old",
      }),
    /snapshot snap-owned has no verified provenance/,
  );
  assert.equal(calls.filter((call) => call.startsWith("DELETE")).length, 0);
});

test("destroy does not claim success when a deleted snapshot remains visible", async () => {
  const sessionState = structuredClone(state);
  sessionState.sessionIds = ["session-old"];
  sessionState.snapshots = [{ id: "snap-owned", sourceSessionId: "session-old" }];
  sessionState.snapshotIds = ["snap-owned"];
  const creds = {
    token: "test-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url, init) => {
      if (new URL(url).pathname === "/api/v2/sandboxes/same-name") return notFound(url);
      return jsonResponse(url, {
        snapshot: snapshotMetadata(
          "snap-owned",
          "session-old",
          init.method === "DELETE" ? "deleted" : "created",
        ),
      });
    },
  };
  await assert.rejects(
    () => destroySandboxAndSnapshots(creds, sessionState, () => {}),
    /snapshots remain after delete/,
  );
  assert.deepEqual(sessionState.snapshotIds, ["snap-owned"]);
  assert.equal(sessionState.snapshots.length, 1);
});

test("destroy refuses unproven legacy snapshot IDs after the Sandbox is gone", async () => {
  const sessionState = structuredClone(state);
  sessionState.snapshotIds = ["snap-unproven"];
  sessionState.snapshots = [];
  const creds = {
    token: "test-token",
    teamId: "team_x",
    projectId: "prj_x",
    fetch: async (url) => notFound(url),
  };
  await assert.rejects(
    () => destroySandboxAndSnapshots(creds, sessionState, () => {}),
    /no verified provenance/,
  );
  assert.deepEqual(sessionState.snapshotIds, ["snap-unproven"]);
});

test("410 and snapshot_not_found cannot prove a Sandbox was deleted", async () => {
  for (const code of ["snapshot_not_found", "sandbox_stopped"]) {
    const sessionState = structuredClone(state);
    sessionState.snapshots = [];
    sessionState.snapshotIds = [];
    const creds = {
      token: "test-token",
      teamId: "team_x",
      projectId: "prj_x",
      fetch: async (url) => jsonResponse(url, { error: { code, message: code } }, 410),
    };
    await assert.rejects(
      () => destroySandboxAndSnapshots(creds, sessionState, () => {}),
      new RegExp(code),
    );
  }
});

test("resume refuses an already-running VM before executing a command", async () => {
  let calls = 0;
  const sandbox = {
    status: "running",
    runCommand: async () => {
      calls++;
      return { exitCode: 0 };
    },
  };
  await assert.rejects(() => resumeSandbox(sandbox), /stop.*active work.*resum/i);
  assert.equal(calls, 0);
});

for (const status of ["stopped", "stopping", "snapshotting"])
  test(`resume supports ${status} through SDK waiting`, async () => {
    const calls = [];
    const sandbox = {
      status,
      runCommand: async (...args) => {
        calls.push(args);
        return { exitCode: 0 };
      },
    };
    await resumeSandbox(sandbox);
    assert.deepEqual(calls, [["true", [], { timeoutMs: 60_000 }]]);
  });
