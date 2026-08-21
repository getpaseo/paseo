import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { OrchestrationGroupStore } from "./orchestration-group-store.js";
import { renderOrchestrationResult } from "./orchestration-result-renderer.js";

function createStore() {
  let now = new Date("2026-08-13T00:00:00.000Z");
  return {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    store: new OrchestrationGroupStore(join(tmpdir(), `paseo-groups-${Math.random()}`), () => now),
  };
}

async function sealedTenChildGroup() {
  const harness = createStore();
  const group = await harness.store.create({
    lineageId: "lineage-1",
    callerAgentId: "parent-1",
    workspaceId: "workspace-1",
    continuationPolicy: "batch",
    timeoutMs: 10_000,
    maxSummaryCharsPerChild: 256,
  });
  for (let index = 0; index < 10; index += 1) {
    await harness.store.registerChild(group.id, `child-${index}`);
  }
  await harness.store.seal(group.id);
  return { ...harness, group };
}

describe("OrchestrationGroupStore", () => {
  test("AC-01: ten terminal events have one idempotent continuation claim", async () => {
    const { store, group } = await sealedTenChildGroup();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.recordTerminalEvent(group.id, {
          agentId: `child-${index}`,
          eventKey: `event-${index}`,
          terminalState: "completed",
          summary: `${index}: ${"x".repeat(300)}`,
          resultPointer: `agents/child-${index}/results/event-${index}.txt`,
        }),
      ),
    );

    const claimed = await Promise.all([
      store.claimContinuation(group.id),
      store.claimContinuation(group.id),
    ]);
    expect(claimed.map((result) => result.claimed)).toEqual([true, false]);
    expect(claimed[0]!.group.children["child-0"]!.summary).toHaveLength(256);

    const duplicate = await store.recordTerminalEvent(group.id, {
      agentId: "child-0",
      eventKey: "event-0",
      terminalState: "completed",
      summary: "ignored",
      resultPointer: "ignored",
    });
    expect(duplicate.recorded).toBe(false);
    expect((await store.claimContinuation(group.id)).claimed).toBe(false);
  });

  test("AC-02: late events after a continuation claim are stored but cannot create another turn", async () => {
    const { store, group } = await sealedTenChildGroup();
    for (let index = 0; index < 10; index += 1) {
      await store.recordTerminalEvent(group.id, {
        agentId: `child-${index}`,
        eventKey: `event-${index}`,
        terminalState: "completed",
        summary: `summary ${index}`,
        resultPointer: `agents/child-${index}/result.txt`,
      });
    }
    await store.claimContinuation(group.id);
    const late = await store.recordTerminalEvent(group.id, {
      agentId: "child-0",
      eventKey: "late-provider-observation",
      terminalState: "failed",
      summary: "must not replace the terminal result",
      resultPointer: "agents/child-0/late.txt",
    });
    expect(late.recorded).toBe(true);
    expect(late.group.children["child-0"]!.terminalState).toBe("completed");
    expect((await store.claimContinuation(group.id)).claimed).toBe(false);
  });

  test("holds an unconfirmed persisted claim after restart instead of retrying", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-group-restart-"));
    const store = new OrchestrationGroupStore(dir, () => new Date("2026-08-13T00:00:00.000Z"));
    const group = await store.create({
      lineageId: "lineage-1",
      callerAgentId: "parent-1",
      workspaceId: "workspace-1",
      continuationPolicy: "batch",
      timeoutMs: 10_000,
      maxSummaryCharsPerChild: 256,
    });
    await store.registerChild(group.id, "child-1");
    await store.seal(group.id);
    await store.recordTerminalEvent(group.id, {
      agentId: "child-1",
      eventKey: "complete-1",
      terminalState: "completed",
      summary: "done",
      resultPointer: "agents/child-1/result.txt",
    });
    await store.claimContinuation(group.id);

    const restarted = new OrchestrationGroupStore(dir);
    const held = await restarted.recoverUnconfirmedClaims();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ state: "held", holdReason: "continuation_dispatch_unknown" });
    expect((await restarted.claimContinuation(group.id)).claimed).toBe(false);
  });

  test("renders only bounded summaries and inspectable pointers", async () => {
    const { store, group } = await sealedTenChildGroup();
    for (let index = 0; index < 10; index += 1) {
      await store.recordTerminalEvent(group.id, {
        agentId: `child-${index}`,
        eventKey: `event-${index}`,
        terminalState: index === 0 ? "held" : "completed",
        summary: `summary-${index}`,
        resultPointer: `agents/child-${index}/result.txt`,
      });
    }
    const result = renderOrchestrationResult((await store.get(group.id))!);
    expect(result).toContain('"resultPointer":"agents/child-0/result.txt"');
    expect(result).not.toContain("full private transcript");
  });
});
