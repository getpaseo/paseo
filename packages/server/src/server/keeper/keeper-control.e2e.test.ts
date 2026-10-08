import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { ControllableAgentClient } from "../test-utils/controllable-agent-client.js";
import { KeeperSendReceipts, sendFingerprint } from "./send-receipts.js";

interface Harness {
  ctx: DaemonTestContext;
  provider: ControllableAgentClient;
  agentId: string;
}

let harness: Harness | null = null;

async function setup(keeperControlEnabled = true): Promise<Harness> {
  const provider = new ControllableAgentClient("codex");
  const ctx = await createDaemonTestContext({
    agentClients: { codex: provider },
    keeperControlEnabled,
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "keeper-e2e-"));
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "keeper" });
  harness = { ctx, provider, agentId: agent.id };
  return harness;
}

afterEach(async () => {
  await harness?.ctx.cleanup();
  harness = null;
}, 60_000);

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function observe(h: Harness) {
  const { snapshot } = await h.ctx.client.keeperGetSnapshot(h.agentId);
  if (!snapshot?.sessionIncarnation) throw new Error("no live snapshot");
  return { ...snapshot, incarnation: snapshot.sessionIncarnation };
}

function sendParams(h: Harness, seen: Awaited<ReturnType<typeof observe>>, key: string) {
  return {
    agentId: h.agentId,
    text: `hello ${key}`,
    idempotencyKey: key,
    expectedSessionIncarnation: seen.incarnation,
    expectedPermissionGeneration: seen.permissionGeneration,
    onActiveTurn: "reject" as const,
  };
}

function expectNoSideEffects(h: Harness): void {
  expect(h.provider.callsOf("startTurn")).toEqual([]);
  expect(h.provider.callsOf("steer")).toEqual([]);
  expect(h.provider.callsOf("interrupt")).toEqual([]);
  expect(h.provider.callsOf("respondToPermission")).toEqual([]);
}

describe("keeper atomic send", () => {
  test("an exact-match send starts one turn and reports what was acknowledged", async () => {
    const h = await setup();
    const seen = await observe(h);
    const reply = await h.ctx.client.keeperSendMessage(sendParams(h, seen, "k1"));
    expect(reply).toMatchObject({ result: "accepted", delivery: "turn_started", reason: null });
    expect(h.provider.callsOf("startTurn")).toEqual([{ kind: "startTurn", text: "hello k1" }]);
    expect(h.provider.callsOf("interrupt")).toEqual([]);
  });

  test("a question that arrived before admission rejects the stale send untouched", async () => {
    const h = await setup();
    const seen = await observe(h);
    h.provider.session.raise({ id: "question-b" });
    await until(async () => (await observe(h)).pending.length === 1, "question B");
    const reply = await h.ctx.client.keeperSendMessage(sendParams(h, seen, "k2"));
    expect(reply).toMatchObject({ result: "rejected", reason: "stale_generation" });
    expectNoSideEffects(h);
    expect((await observe(h)).pending.map((p) => p.permissionRequestId)).toEqual(["question-b"]);
  });

  test("a replaced session rejects a send aimed at the old incarnation", async () => {
    const h = await setup();
    const seen = await observe(h);
    await h.ctx.daemon.daemon.agentManager.reloadAgentSession(h.agentId);
    expect(h.provider.sessions).toHaveLength(2);
    const reply = await h.ctx.client.keeperSendMessage(sendParams(h, seen, "k3"));
    expect(reply).toMatchObject({ result: "rejected", reason: "stale_incarnation" });
    expectNoSideEffects(h);
  });

  test("a question raised while the provider holds the send stays pending", async () => {
    const h = await setup();
    const seen = await observe(h);
    const release = h.provider.holdStartTurn();
    const sending = h.ctx.client.keeperSendMessage(sendParams(h, seen, "k4"));
    await until(() => h.provider.heldStarts === 1, "provider to hold the start");
    h.provider.session.raise({ id: "question-b" });
    release();
    expect(await sending).toMatchObject({ result: "accepted" });
    await until(async () => (await observe(h)).pending.length === 1, "question B pending");
    expect(h.provider.callsOf("respondToPermission")).toEqual([]);
    expect(h.provider.callsOf("interrupt")).toEqual([]);
    expect(h.provider.callsOf("startTurn")).toHaveLength(1);
  });

  test("a retry that overlaps the first attempt sends at most once", async () => {
    const h = await setup();
    const seen = await observe(h);
    const release = h.provider.holdStartTurn();
    const params = sendParams(h, seen, "k5");
    const first = h.ctx.client.keeperSendMessage(params);
    await until(() => h.provider.heldStarts === 1, "provider to hold the start");
    const retry = h.ctx.client.keeperSendMessage(params);
    release();
    expect((await first).result).toBe("accepted");
    expect(await retry).toMatchObject({ result: "duplicate", delivery: "turn_started" });
    expect(h.provider.callsOf("startTurn")).toHaveLength(1);
  });

  test("a pending receipt left by an uncertain attempt blocks any resend", async () => {
    const h = await setup();
    const seen = await observe(h);
    const params = sendParams(h, seen, "k6");
    const receipts = new KeeperSendReceipts(
      path.join(h.ctx.daemon.paseoHome, "keeper-send-receipts"),
    );
    await receipts.reserve(h.agentId, "k6", sendFingerprint(params.text, params.onActiveTurn));
    expect(await h.ctx.client.keeperSendMessage(params)).toMatchObject({
      result: "outcome_unknown",
    });
    const conflict = await h.ctx.client.keeperSendMessage({ ...params, text: "different" });
    expect(conflict).toMatchObject({ result: "rejected", reason: "idempotency_conflict" });
    expectNoSideEffects(h);
  });

  test("a pending question rejects a send unless the caller allows it", async () => {
    const h = await setup();
    h.provider.session.raise({ id: "question-a" });
    await until(async () => (await observe(h)).pending.length === 1, "question A");
    const seen = await observe(h);
    const reply = await h.ctx.client.keeperSendMessage(sendParams(h, seen, "k7"));
    expect(reply).toMatchObject({ result: "rejected", reason: "permission_pending" });
    expectNoSideEffects(h);
  });

  test("onActiveTurn reject refuses a running turn and steer delivers into it", async () => {
    const h = await setup();
    const first = await observe(h);
    await h.ctx.client.keeperSendMessage(sendParams(h, first, "k8a"));
    const busy = await observe(h);
    const refused = await h.ctx.client.keeperSendMessage(sendParams(h, busy, "k8b"));
    expect(refused).toMatchObject({ result: "rejected", reason: "turn_active" });
    const steered = await h.ctx.client.keeperSendMessage({
      ...sendParams(h, busy, "k8c"),
      onActiveTurn: "steer",
    });
    expect(steered).toMatchObject({ result: "accepted", delivery: "steered" });
    expect(h.provider.callsOf("steer")).toHaveLength(1);
    expect(h.provider.callsOf("interrupt")).toEqual([]);
  });

  test("a question arriving during the durable reserve is caught by the second comparison", async () => {
    const h = await setup();
    const seen = await observe(h);
    let committed = false;
    let released = false;
    const result = await h.ctx.daemon.daemon.agentManager.admitGuarded(
      h.agentId,
      {
        expectedSessionIncarnation: seen.incarnation,
        expectedPermissionGeneration: seen.permissionGeneration,
        reserve: async () => {
          h.provider.session.raise({ id: "question-b" });
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true };
        },
        release: async () => {
          released = true;
        },
      },
      async () => {
        committed = true;
      },
    );
    expect(result).toMatchObject({ rejected: "stale_generation" });
    expect({ committed, released }).toEqual({ committed: false, released: true });
    expectNoSideEffects(h);
    expect((await observe(h)).pending).toHaveLength(1);
  });

  test("the event feed resumes from a cursor without loss or duplication", async () => {
    const h = await setup();
    const start = (await observe(h)).eventCursor;
    h.provider.session.raise({ id: "q1", title: "TOP-SECRET-TITLE", input: { token: "sk-leak" } });
    h.provider.session.raise({ id: "q2", kind: "tool" });
    const all = await h.ctx.client.keeperReadEvents({ cursor: start, limit: 100, waitMs: 2_000 });
    await until(async () => {
      const page = await h.ctx.client.keeperReadEvents({ cursor: start, limit: 100 });
      return page.events.length >= 2;
    }, "two events");
    const full = await h.ctx.client.keeperReadEvents({ cursor: start, limit: 100 });
    const paged = [] as typeof full.events;
    let cursor = start;
    for (let i = 0; i < 10; i += 1) {
      const page = await h.ctx.client.keeperReadEvents({ cursor, limit: 1 });
      if (page.events.length === 0) break;
      paged.push(...page.events);
      cursor = page.nextCursor;
    }
    expect(paged.map((e) => e.eventId)).toEqual(full.events.map((e) => e.eventId));
    expect(new Set(paged.map((e) => e.seq)).size).toBe(paged.length);
    expect(full.events.map((e) => e.category)).toEqual(["question", "permission"]);
    expect(JSON.stringify([all, full])).not.toMatch(/TOP-SECRET-TITLE|sk-leak/);
    const after = await h.ctx.client.keeperReadEvents({ cursor, limit: 10 });
    expect(after.events).toEqual([]);
    const detail = await h.ctx.client.keeperGetPendingRequest({
      agentId: h.agentId,
      permissionRequestId: "q1",
      expectedSessionIncarnation: full.events[0].sessionIncarnation ?? "",
      expectedPermissionGeneration: (await observe(h)).permissionGeneration,
    });
    expect(detail.detail?.title).toBe("TOP-SECRET-TITLE");
  });

  test("a keeper RPC is refused when the daemon has not opted in", async () => {
    const h = await setup(false);
    const reply = await h.ctx.client.keeperSendMessage({
      agentId: h.agentId,
      text: "x",
      idempotencyKey: "off",
      expectedSessionIncarnation: "i",
      expectedPermissionGeneration: 0,
      onActiveTurn: "reject",
    });
    expect(reply).toMatchObject({ result: "rejected", reason: "disabled" });
    expectNoSideEffects(h);
  });
});
