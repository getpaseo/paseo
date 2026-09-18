import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitize,
  conversationEvidence,
  assertContinuity,
  verifyExport,
  assertInterrupted,
  waitUntil,
  hash,
  stageOrder,
  cleanupAll,
  waitForUiGate,
  atomicJson,
  fileHash,
  assertDisjointDirectories,
} from "../scripts/live-support.mjs";

test("redacts pairing offers, environment secrets and both subprocess output streams", () => {
  const secret = "test-provider-secret-123";
  const offer = "https://app.paseo.sh/#offer=eyJzZWNyZXQiOiJ2YWx1ZSJ9";
  const result = sanitize(
    {
      stdout: `command --host ${offer}`,
      stderr: `Bearer ${secret}`,
      nested: { AI_GATEWAY_API_KEY: secret, pairingUrl: offer },
    },
    [secret],
  );
  const output = JSON.stringify(result);
  for (const value of [secret, offer, "eyJzZWNyZXQiOiJ2YWx1ZSJ9"])
    assert.ok(!output.includes(value));
  assert.ok(output.includes("[REDACTED]"));
  assert.ok(
    !sanitize(`key=${encodeURIComponent(secret)} ${encodeURIComponent(offer)}`, [secret]).includes(
      secret,
    ),
  );
});

const agent = {
  id: "agent-one",
  provider: "codex",
  workspaceId: "workspace-one",
  cwd: "/repo",
  status: "idle",
  persistence: { provider: "codex", sessionId: "thread-one", nativeHandle: "thread-one" },
};
const items = [
  { type: "user_message", text: "Fix the test" },
  { type: "assistant_message", text: "Fixed and tested" },
];
const page = (values = items) => ({
  entries: values.map((item) => ({ item })),
  error: null,
  gap: false,
  hasOlder: false,
  hasNewer: false,
});

test("same agent ID cannot conceal a changed provider thread or lost history", () => {
  const before = conversationEvidence(agent, page());
  assertContinuity(before, conversationEvidence(agent, page()));
  const changed = conversationEvidence(
    { ...agent, persistence: { ...agent.persistence, sessionId: "other" } },
    page(),
  );
  assert.throws(() => assertContinuity(before, changed), /sessionId/);
  assert.throws(
    () => assertContinuity(before, conversationEvidence(agent, page(items.slice(0, 1)))),
    /history/,
  );
  assert.throws(() => conversationEvidence({ ...agent, persistence: null }, page()), /persistence/);
  assert.throws(() => conversationEvidence(agent, { ...page(), hasOlder: true }), /incomplete/);
});

test("follow-up must preserve ordered message content and add a conversation turn", () => {
  const before = conversationEvidence(agent, page());
  const after = conversationEvidence(
    agent,
    page([
      ...items,
      { type: "user_message", text: "Continue" },
      { type: "assistant_message", text: "Done" },
    ]),
  );
  assertContinuity(before, after, true);
  assert.throws(() => assertContinuity(before, before, true), /new turn/);
  assert.throws(
    () => assertContinuity(before, conversationEvidence(agent, page(items.toReversed()))),
    /history/,
  );
});

test("export checks local bytes against remote hashes, including untracked files", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-runner-export-"));
  try {
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", "tracked.txt"), "tracked");
    writeFileSync(join(dir, "repo", "untracked.txt"), "untracked");
    const manifest = {
      "./repo/tracked.txt": hash("tracked"),
      "./repo/untracked.txt": hash("untracked"),
    };
    assert.equal(verifyExport(dir, manifest).files, 2);
    writeFileSync(join(dir, "repo", "tracked.txt"), "corrupt");
    assert.throws(() => verifyExport(dir, manifest), /hash mismatch/);
    assert.throws(() => verifyExport(dir, { "../escape": hash("x") }), /unsafe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interruption requires a new boot, a dead process, unchanged heartbeat and one start", () => {
  const before = {
    bootId: "old",
    scriptHash: hash("program"),
    marker: { seq: 8 },
    starts: [{ nonce: "one" }],
    activePids: [12],
    done: false,
  };
  const after = { ...before, bootId: "new", activePids: [] };
  assertInterrupted(before, after);
  for (const bad of [
    { ...after, bootId: "old" },
    { ...after, activePids: [30] },
    { ...after, marker: { seq: 9 } },
    { ...after, starts: [...after.starts, { nonce: "two" }] },
    { ...after, done: true },
    { ...after, scriptHash: hash("changed") },
  ]) {
    assert.throws(() => assertInterrupted(before, bad));
  }
});

test("readiness polls observe progress and time out instead of treating a delay as proof", async () => {
  let n = 0;
  assert.equal(
    await waitUntil(
      async () => ++n,
      (value) => value >= 3,
      { timeoutMs: 100, intervalMs: 1 },
    ),
    3,
  );
  await assert.rejects(
    waitUntil(async () => false, Boolean, { timeoutMs: 5, intervalMs: 1 }),
    /deadline/,
  );
});

test("full journey includes negative probes before final cleanup", () => {
  assert.ok(stageOrder.includes("failures"));
  assert.equal(stageOrder.at(-1), "export-cleanup");
});

test("cleanup attempts every owned resource even if deletion and evidence reporting fail", async () => {
  const attempted = [];
  const errors = await cleanupAll(
    [{ id: "one" }, { id: "two" }, { id: "three" }],
    async (item) => {
      attempted.push(item.id);
      if (item.id !== "two") throw new Error("delete failed");
    },
    () => {
      throw new Error("receipt storage failed");
    },
  );
  assert.deepEqual(attempted, ["one", "two", "three"]);
  assert.deepEqual(
    errors.map((item) => item.id),
    ["one", "three"],
  );
});

test("UI gate is optional, bounded, abortable and emits only session coordination data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-runner-ui-"));
  try {
    const events = [];
    const record = (step, details) => events.push({ step, ...details });
    await waitForUiGate(undefined, "one", record);
    assert.deepEqual(events, []);
    const gate = join(dir, "released");
    const pending = waitForUiGate(gate, "one", record, { timeoutMs: 60, intervalMs: 1 });
    assert.equal(events[0].step, "ui-ready");
    assert.equal(events[0].sessionId, "one");
    writeFileSync(gate, "");
    await pending;
    assert.equal(events.at(-1).step, "ui-gate-released");
    await assert.rejects(
      waitForUiGate(join(dir, "absent"), "one", record, { timeoutMs: 5, intervalMs: 1 }),
      /deadline/,
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(waitForUiGate(gate, "one", record, { signal: abort.signal }));
    await waitForUiGate(gate, "one", record, { timeoutMs: 900_000 });
    assert.equal(events.at(-2).maximumWaitMs, 600_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guarded checkpoint refuses a stale state patch and preserves the newer bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-runner-state-"));
  try {
    const path = join(dir, "state.json");
    atomicJson(path, { phase: "old" }, "MISSING");
    const before = fileHash(path);
    atomicJson(path, { phase: "new" }, before);
    const newer = fileHash(path);
    assert.throws(() => atomicJson(path, { phase: "stale" }, before), /STALE_PRECONDITION/);
    assert.equal(fileHash(path), newer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provision and malformed identity diagnostics are scrubbed before offer registration", () => {
  const encoded = "eyJwcml2YXRlIjoiZGF0YSJ9";
  const key = Buffer.alloc(32, 19).toString("base64");
  const offer = `https://app.paseo.sh/#offer=${encoded}`;
  const outputs = [
    JSON.stringify({ id: "session", pairingUrl: offer, daemonPublicKeyB64: key }),
    `Invalid pairing offer: ${offer}`,
    `Malformed identity #offer=not-valid-base64! daemonPublicKeyB64="${key}"`,
    `Cannot connect: ${encodeURIComponent(offer)}`,
  ];
  for (const stdout of outputs) {
    const result = JSON.stringify(sanitize({ stdout, stderr: stdout }));
    for (const secret of [offer, encoded, key, "not-valid-base64!"])
      assert.ok(!result.includes(secret));
  }
});

test("state and receipts must be disjoint, including nested and symlink aliases", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-runner-dirs-"));
  try {
    const state = join(dir, "state");
    mkdirSync(state);
    assertDisjointDirectories(state, join(dir, "state-receipts"));
    for (const [a, b] of [
      [state, state],
      [state, join(state, "receipts")],
      [join(state, "receipts"), state],
      [state, join(state, "..", "state", "child")],
    ]) {
      assert.throws(() => assertDisjointDirectories(a, b), /disjoint/);
    }
    const alias = join(dir, "alias");
    symlinkSync(state, alias);
    assert.throws(() => assertDisjointDirectories(state, join(alias, "new-receipts")), /disjoint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex streaming presentation boundary does not change recovered message content", () => {
  const live = [
    ...items,
    {
      type: "assistant_message",
      messageId: "response-two",
      text: "\n\n---\n\nVerified the tests.",
    },
  ];
  const restored = [
    ...items,
    { type: "assistant_message", messageId: "response-two", text: "Verified the tests." },
  ];
  assertContinuity(
    conversationEvidence(agent, page(live)),
    conversationEvidence(agent, page(restored)),
  );
  assert.throws(
    () =>
      assertContinuity(
        conversationEvidence(agent, page(live)),
        conversationEvidence(
          agent,
          page([...items, { ...restored[2], text: "Different content." }]),
        ),
      ),
    /history/,
  );
});

test("identical assistant text cannot conceal a replaced provider message ID", () => {
  const first = [...items, { type: "assistant_message", messageId: "original", text: "Same text" }];
  const changed = [
    ...items,
    { type: "assistant_message", messageId: "replacement", text: "Same text" },
  ];
  assert.throws(
    () =>
      assertContinuity(
        conversationEvidence(agent, page(first)),
        conversationEvidence(agent, page(changed)),
      ),
    /history/,
  );
});

test("a literal boundary on the first assistant message in a turn is content", () => {
  const first = [
    items[0],
    { type: "assistant_message", messageId: "one", text: "\n\n---\n\nLiteral leading separator" },
  ];
  const changed = [items[0], { ...first[1], text: "Literal leading separator" }];
  assert.throws(
    () =>
      assertContinuity(
        conversationEvidence(agent, page(first)),
        conversationEvidence(agent, page(changed)),
      ),
    /history/,
  );
});

test("missing-provider live branch uses the current diagnostic export and rejects readiness", async () => {
  const { assertProviderUnavailable } = await import("../scripts/live.mjs");
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "inert-diagnostic-key";
  const state = {
    agentProvider: "claude",
    agentModel: "anthropic/claude-sonnet-5",
    paseoHome: "/test/paseo",
  };
  const calls = [];
  const fake = (diagnostic) => ({
    runCommand: async (params) => {
      calls.push(params);
      return {
        exitCode: 0,
        stdout: async () => JSON.stringify({ provider: "claude", diagnostic }),
        stderr: async () => "",
      };
    },
  });
  try {
    await assertProviderUnavailable(
      fake("Claude\n  Binary: not found\n  Models: —\n  Status: Unavailable"),
      state,
    );
    assert.match(calls[0].args.join(" "), /diagnostic claude/);
    await assert.rejects(
      () => assertProviderUnavailable(fake("Claude\n  Models: 1\n  Status: Ready"), state),
      /Missing provider binary/,
    );
  } finally {
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = oldKey;
  }
});
