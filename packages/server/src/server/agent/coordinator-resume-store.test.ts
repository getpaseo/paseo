import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CoordinatorResumeStore } from "./coordinator-resume-store.js";

describe("CoordinatorResumeStore", () => {
  let root: string;
  let filePath: string;
  let nowMs: number;
  let nextId: number;
  let store: CoordinatorResumeStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "coordinator-resume-store-"));
    filePath = join(root, "outbox.json");
    nowMs = Date.parse("2026-07-28T12:00:00.000Z");
    nextId = 1;
    store = new CoordinatorResumeStore(filePath, {
      now: () => new Date(nowMs),
      idFactory: () => `id-${nextId++}`,
      baseRetryMs: 100,
      maxRetryMs: 1_000,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function armAndPromote() {
    const armed = await store.arm({
      childAgentId: "child-1",
      coordinatorAgentId: "coordinator-1",
    });
    await store.bindChildTurn(armed.eventId, "child-turn-1");
    const [pending] = await store.promoteChild({
      childAgentId: "child-1",
      childTurnId: "child-turn-1",
      outcome: "completed",
      currentParentAgentId: "coordinator-1",
    });
    return { armed, pending };
  }

  test("persists only stable metadata while arming and promoting", async () => {
    const { armed, pending } = await armAndPromote();

    expect(armed.state).toBe("armed");
    expect(pending).toMatchObject({
      eventId: armed.eventId,
      state: "pending",
      childTurnId: "child-turn-1",
      childOutcome: "completed",
      childOutcomeId: "child-1:child-turn-1:completed",
      resultLocator: "agent-timeline:child-1:child-turn-1",
    });

    const serialized = await readFile(filePath, "utf8");
    for (const forbidden of [
      "prompt",
      "title",
      "cwd",
      "host",
      "command",
      "reportText",
      "environment",
      "credential",
      "secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await expect(new CoordinatorResumeStore(filePath).list()).resolves.toEqual(await store.list());
  });

  test("leases once, delivers with the provider turn id, and acks only that completed turn", async () => {
    await armAndPromote();
    const leased = await store.leaseNext({ leaseMs: 1_000 });
    expect(leased).toMatchObject({ state: "leased", attempt: 1, leaseId: "id-2" });

    const delivered = await store.markDelivered({
      eventId: leased!.eventId,
      leaseId: leased!.leaseId!,
      coordinatorTurnId: "coordinator-turn-1",
    });
    expect(delivered.state).toBe("delivered");

    await store.recordCoordinatorTerminal({
      coordinatorAgentId: "coordinator-1",
      coordinatorTurnId: "unrelated-turn",
      outcome: "completed",
    });
    expect((await store.list())[0]?.state).toBe("delivered");

    await store.recordCoordinatorTerminal({
      coordinatorAgentId: "coordinator-1",
      coordinatorTurnId: "coordinator-turn-1",
      outcome: "completed",
    });
    expect((await store.list())[0]).toMatchObject({
      state: "acked",
      coordinatorTurnId: "coordinator-turn-1",
      ackedAt: "2026-07-28T12:00:00.000Z",
    });
  });

  test("does not expire an active delivery and recovers it after daemon restart", async () => {
    const { armed } = await armAndPromote();
    const firstLease = await store.leaseNext({ leaseMs: 1_000 });
    await store.markDelivered({
      eventId: firstLease!.eventId,
      leaseId: firstLease!.leaseId!,
      coordinatorTurnId: "coordinator-turn-1",
    });

    nowMs += 1_001;
    await store.reconcile();
    await expect(store.leaseNext({ leaseMs: 1_000 })).resolves.toBeNull();

    const restarted = new CoordinatorResumeStore(filePath, {
      now: () => new Date(nowMs),
      idFactory: () => `restart-${nextId++}`,
      baseRetryMs: 100,
      maxRetryMs: 1_000,
    });
    await restarted.reconcileStartup();
    const secondLease = await restarted.leaseNext({ leaseMs: 1_000 });
    expect(secondLease).toMatchObject({
      eventId: armed.eventId,
      state: "leased",
      attempt: 2,
    });

    await restarted.releaseLease({
      eventId: secondLease!.eventId,
      leaseId: secondLease!.leaseId!,
    });
    expect((await restarted.list())[0]).toMatchObject({
      eventId: armed.eventId,
      state: "pending",
      nextAttemptAt: "2026-07-28T12:00:01.201Z",
    });
  });

  test("serializes concurrent leases so only one worker owns the event", async () => {
    await armAndPromote();
    const [first, second] = await Promise.all([
      store.leaseNext({ leaseMs: 1_000 }),
      store.leaseNext({ leaseMs: 1_000 }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  test("records cancellation and ownership changes without promotion", async () => {
    const first = await store.arm({
      childAgentId: "child-1",
      coordinatorAgentId: "coordinator-1",
    });
    await store.bindChildTurn(first.eventId, "child-turn-1");
    await store.cancelChildTurn({ childAgentId: "child-1", childTurnId: "child-turn-1" });

    const second = await store.arm({
      childAgentId: "child-1",
      coordinatorAgentId: "coordinator-1",
    });
    await store.bindChildTurn(second.eventId, "child-turn-2");
    await store.promoteChild({
      childAgentId: "child-1",
      childTurnId: "child-turn-2",
      outcome: "failed",
      currentParentAgentId: "different-parent",
    });

    expect(await store.list()).toMatchObject([
      { eventId: first.eventId, state: "child_canceled", childOutcome: null },
      { eventId: second.eventId, state: "ownership_changed", childOutcome: null },
    ]);
    await expect(store.leaseNext({ leaseMs: 1_000 })).resolves.toBeNull();
  });

  test("reconciles a crash between arming and starting without inventing a child turn", async () => {
    const armed = await store.arm({
      childAgentId: "child-1",
      coordinatorAgentId: "coordinator-1",
    });

    const restarted = new CoordinatorResumeStore(filePath, {
      now: () => new Date(nowMs),
      idFactory: () => `restart-${nextId++}`,
    });
    await restarted.reconcileStartup();

    expect((await restarted.list())[0]).toMatchObject({
      eventId: armed.eventId,
      childTurnId: null,
      childOutcome: "failed",
      childOutcomeId: `child-1:${armed.eventId}:failed`,
      resultLocator: `agent-timeline:child-1:${armed.eventId}`,
      state: "pending",
    });
  });

  test("reconciles a crash after binding the child turn without losing the event", async () => {
    const armed = await store.arm({
      childAgentId: "child-1",
      coordinatorAgentId: "coordinator-1",
    });
    await store.bindChildTurn(armed.eventId, "child-turn-1");

    const restarted = new CoordinatorResumeStore(filePath, {
      now: () => new Date(nowMs),
      idFactory: () => `restart-${nextId++}`,
    });
    await restarted.reconcileStartup();

    expect((await restarted.list())[0]).toMatchObject({
      eventId: armed.eventId,
      childTurnId: "child-turn-1",
      childOutcome: "failed",
      childOutcomeId: "child-1:child-turn-1:failed",
      resultLocator: "agent-timeline:child-1:child-turn-1",
      state: "pending",
    });
  });
});
