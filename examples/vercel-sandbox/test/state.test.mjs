import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const stateRoot = mkdtempSync(join(tmpdir(), "paseo-sandbox-state-test-"));
process.env.HOME = stateRoot;
process.env.PASEO_SANDBOX_STATE_DIR = join(stateRoot, "isolated-state");

const { newState, saveState, loadState, statePath, stateDirectory, trackProvision } =
  await import("../dist/state.js");

test("newState produces an intent-phase state with unique owner", () => {
  const a = newState({
    region: "iad1",
    image: "vercel/sandbox/node:24",
    teamId: "team_x",
    projectId: "prj_x",
    agentProvider: "codex",
    agentModel: "openai/gpt-6-astra",
    workspacePath: "/vercel/workspace",
    repoPath: "/vercel/workspace/repo",
    paseoHome: "/vercel/paseo-home",
  });
  assert.equal(a.phase, "intent");
  assert.ok(a.owner.length > 0);
  assert.match(a.sandboxName, /^paseo-sandbox-/);
});

test("save and load round-trip with atomic write", () => {
  const s = newState({
    region: "iad1",
    image: "vercel/sandbox/node:24",
    teamId: "team_x",
    projectId: "prj_x",
    agentProvider: "codex",
    agentModel: "openai/gpt-6-astra",
    workspacePath: "/vercel/workspace",
    repoPath: "/vercel/workspace/repo",
    paseoHome: "/vercel/paseo-home",
  });
  saveState(s);
  const loaded = loadState(s.id);
  assert.equal(loaded.id, s.id);
  assert.equal(loaded.owner, s.owner);
  assert.ok(existsSync(statePath(s.id)));
});

test("loadState throws for unknown session", () => {
  assert.throws(() => loadState(randomUUID()), /No session state/);
});

test("session IDs cannot traverse the state directory", () => {
  assert.throws(() => statePath("../escape"), /invalid session id/i);
});

test("state file permissions are owner-only", async () => {
  const { statSync } = await import("node:fs");
  const s = newState({
    region: "iad1",
    image: "vercel/sandbox/node:24",
    teamId: "team_x",
    projectId: "prj_x",
    agentProvider: "codex",
    agentModel: "openai/gpt-6-astra",
    workspacePath: "/vercel/workspace",
    repoPath: "/vercel/workspace/repo",
    paseoHome: "/vercel/paseo-home",
  });
  saveState(s);
  const mode = statSync(statePath(s.id)).mode & 0o777;
  assert.equal(mode, 0o600);
  const directoryMode = statSync(stateDirectory()).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(stateDirectory(), join(stateRoot, "isolated-state", "sessions"));
});

for (const phase of ["created", "bootstrapping", "ready"]) {
  test(`provision failure in ${phase} persists a redacted failure and resource identity`, async () => {
    const id = randomUUID();
    const secret = "provision-test-secret";
    process.env.AI_GATEWAY_API_KEY = secret;
    const state = {
      id,
      phase,
      sessionIds: ["owned-session"],
      snapshots: [],
      snapshotIds: [],
      logs: [],
      pairingUrl: "https://app.paseo.sh/#offer=private-test",
    };
    try {
      await assert.rejects(
        trackProvision(state, async () => {
          throw new Error(`install failed ${secret}`);
        }),
        (error) => {
          assert.ok(!String(error).includes(secret));
          assert.match(String(error), new RegExp(`paseo-sandbox destroy ${id}`));
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      const persisted = loadState(id);
      assert.equal(persisted.phase, "failed");
      assert.ok(!persisted.lastError.includes(secret));
      assert.deepEqual(persisted.sessionIds, ["owned-session"]);
      assert.equal(persisted.pairingUrl, state.pairingUrl);
    } finally {
      delete process.env.AI_GATEWAY_API_KEY;
    }
  });
}

test("provision success returns the operation result", async () => {
  const state = { id: randomUUID(), phase: "ready" };
  assert.equal(await trackProvision(state, async () => "paired"), "paired");
  assert.equal(state.phase, "ready");
});
