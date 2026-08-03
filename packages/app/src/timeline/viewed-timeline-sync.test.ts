import { expect, test, vi } from "vitest";
import type { ProjectedTimelineForwardFetchPlan } from "./timeline-sync-plan";
import { createViewedTimelineSync } from "./viewed-timeline-sync";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface MembershipRequest {
  agentIds: string[];
  succeed(): void;
  fail(message: string): void;
}

interface TimelineFetch {
  agentId: string;
  request: ProjectedTimelineForwardFetchPlan;
  respond(input: { hasNewer: boolean; seq?: number }): void;
  fail(message: string): void;
}

class TimelineWorld {
  readonly errors: string[] = [];
  readonly sync = createViewedTimelineSync({
    initialDeliveryMode: "selective",
    setSubscription: async (agentIds) => {
      const result = deferred<void>();
      this.memberships.push({
        agentIds,
        succeed: () => result.resolve(),
        fail: (message) => result.reject(new Error(message)),
      });
      this.releaseMembershipWaiter();
      return result.promise;
    },
    fetchPage: async (agentId, request) => {
      const result = deferred<{
        hasNewer: boolean;
        endCursor: { epoch: string; seq: number } | null;
      }>();
      this.fetches.push({
        agentId,
        request,
        respond: ({ hasNewer, seq = 1 }) =>
          result.resolve({
            hasNewer,
            endCursor: { epoch: `epoch-${agentId}`, seq },
          }),
        fail: (message) => result.reject(new Error(message)),
      });
      this.releaseFetchWaiters();
      return result.promise;
    },
    reportError: (error) => {
      this.errors.push(error instanceof Error ? error.message : String(error));
      const waiter = this.errorWaiters.shift();
      if (waiter) waiter(this.errors.at(-1) ?? "");
    },
    schedule: (task, delayMs) => {
      const scheduled = { task, delayMs };
      this.scheduled.push(scheduled);
      const waiter = this.retryWaiters.shift();
      if (waiter && delayMs === 1_000) {
        this.scheduled.splice(this.scheduled.indexOf(scheduled), 1);
        waiter(task);
      }
      return () => {
        const index = this.scheduled.indexOf(scheduled);
        if (index >= 0) this.scheduled.splice(index, 1);
      };
    },
  });

  private readonly memberships: MembershipRequest[] = [];
  private readonly membershipWaiters: Array<(request: MembershipRequest) => void> = [];
  private readonly fetches: TimelineFetch[] = [];
  private readonly fetchWaiters: Array<{
    agentId: string;
    resolve(fetch: TimelineFetch): void;
  }> = [];
  private readonly errorWaiters: Array<(message: string) => void> = [];
  private readonly scheduled: Array<{ task: () => void; delayMs: number }> = [];
  private readonly retryWaiters: Array<(retry: () => void) => void> = [];

  nextMembership(): Promise<MembershipRequest> {
    const request = this.memberships.shift();
    if (request) return Promise.resolve(request);
    return new Promise((resolve) => this.membershipWaiters.push(resolve));
  }

  nextFetch(agentId: string): Promise<TimelineFetch> {
    const index = this.fetches.findIndex((fetch) => fetch.agentId === agentId);
    if (index >= 0) return Promise.resolve(this.fetches.splice(index, 1)[0]);
    return new Promise((resolve) => this.fetchWaiters.push({ agentId, resolve }));
  }

  expectNoPendingMembership(): void {
    expect(this.memberships).toEqual([]);
  }

  expectNoPendingFetch(): void {
    expect(this.fetches).toEqual([]);
  }

  nextError(): Promise<string> {
    const message = this.errors.at(-1);
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.errorWaiters.push(resolve));
  }

  nextRetry(): Promise<() => void> {
    const index = this.scheduled.findIndex((entry) => entry.delayMs === 1_000);
    if (index >= 0) return Promise.resolve(this.scheduled.splice(index, 1)[0].task);
    return new Promise((resolve) => this.retryWaiters.push(resolve));
  }

  elapse(elapsedMs: number): void {
    const due = this.scheduled.filter((entry) => entry.delayMs <= elapsedMs);
    this.scheduled.splice(
      0,
      this.scheduled.length,
      ...this.scheduled.filter((entry) => entry.delayMs > elapsedMs),
    );
    for (const entry of due) entry.task();
  }

  private releaseMembershipWaiter(): void {
    const waiter = this.membershipWaiters.shift();
    if (!waiter) return;
    const request = this.memberships.shift();
    if (request) waiter(request);
  }

  private releaseFetchWaiters(): void {
    for (let waiterIndex = this.fetchWaiters.length - 1; waiterIndex >= 0; waiterIndex -= 1) {
      const waiter = this.fetchWaiters[waiterIndex];
      const index = this.fetches.findIndex((fetch) => fetch.agentId === waiter.agentId);
      if (index < 0) continue;
      this.fetchWaiters.splice(waiterIndex, 1);
      waiter.resolve(this.fetches.splice(index, 1)[0]);
    }
  }
}

test("uses a tail fetch when an agent becomes visible", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const fetch = await world.nextFetch("agent-a");
  expect(fetch.request).toEqual({ direction: "tail", limit: 40, projection: "projected" });
  fetch.respond({ hasNewer: false });
});

test("a gap absorbed by a running tail is recovered after the tail completes", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const tail = await world.nextFetch("agent-a");

  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 9 });

  world.expectNoPendingFetch();
  tail.respond({ hasNewer: false });

  const recovery = await world.nextFetch("agent-a");
  expect(recovery.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 9 },
    limit: 40,
    projection: "projected",
  });
  recovery.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
});

test("an idle reconciliation waits for an in-flight tail and fetches a fresh snapshot", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const initialTail = await world.nextFetch("agent-a");

  world.sync.reconcileAgent("agent-a");

  world.expectNoPendingFetch();
  initialTail.respond({ hasNewer: false });

  const reconciliation = await world.nextFetch("agent-a");
  expect(reconciliation.request).toEqual({
    direction: "tail",
    limit: 40,
    projection: "projected",
  });
  reconciliation.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
});

test("does not reconcile an agent outside the viewed membership", () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);

  world.sync.reconcileAgent("agent-a");

  world.expectNoPendingFetch();
  world.expectNoPendingMembership();
});

test("unchanged visible-set publication does not cancel paged catch-up", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("pending");
  const membership = await world.nextMembership();
  membership.succeed();
  const firstPage = await world.nextFetch("agent-a");

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a", "agent-a"]);
  firstPage.respond({ hasNewer: true, seq: 5 });
  const secondPage = await world.nextFetch("agent-a");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("pending");
  secondPage.respond({ hasNewer: false });

  await vi.waitFor(() => {
    expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready");
  });

  expect(secondPage.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 5 },
    limit: 40,
    projection: "projected",
  });
  world.expectNoPendingMembership();
});

test("all acknowledged agents begin catch-up independently", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-b", "agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const [agentA, agentB] = await Promise.all([
    world.nextFetch("agent-a"),
    world.nextFetch("agent-b"),
  ]);
  agentA.respond({ hasNewer: false });
  agentB.respond({ hasNewer: false });

  expect(membership.agentIds).toEqual(["agent-a", "agent-b"]);
});

test("an eviction during acknowledgement never catches up the stale hot set", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", [
    "agent-a",
    "agent-b",
    "agent-c",
    "agent-d",
    "agent-e",
  ]);
  const staleMembership = await world.nextMembership();
  world.sync.replaceVisibleAgentIds("workspace", ["agent-f"]);
  staleMembership.succeed();
  const currentMembership = await world.nextMembership();
  currentMembership.succeed();
  const currentCatchUps = await Promise.all(
    ["agent-a", "agent-b", "agent-c", "agent-d", "agent-f"].map((agentId) =>
      world.nextFetch(agentId),
    ),
  );
  for (const catchUp of currentCatchUps) catchUp.respond({ hasNewer: false });

  expect({ stale: staleMembership.agentIds, current: currentMembership.agentIds }).toEqual({
    stale: ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"],
    current: ["agent-a", "agent-b", "agent-c", "agent-d", "agent-f"],
  });
  world.expectNoPendingFetch();
});

test("disconnect cancels paging and reconnect restores membership before fresh catch-up", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const firstMembership = await world.nextMembership();
  firstMembership.succeed();
  const stalePage = await world.nextFetch("agent-a");

  world.sync.setConnected(false);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("pending");
  stalePage.respond({ hasNewer: true, seq: 8 });
  world.sync.setConnected(true);
  const restoredMembership = await world.nextMembership();
  restoredMembership.succeed();
  const restoredPage = await world.nextFetch("agent-a");
  restoredPage.respond({ hasNewer: false });

  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  expect(restoredMembership.agentIds).toEqual(["agent-a"]);
  world.expectNoPendingFetch();
});

test("navigation while disconnected reconnects only the currently visible agent", async () => {
  const world = new TimelineWorld();
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);

  world.sync.setConnected(true);
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUp = await world.nextFetch("agent-b");
  catchUp.respond({ hasNewer: false });

  expect(membership.agentIds).toEqual(["agent-b"]);
  world.expectNoPendingFetch();
});

test("overlapping sources deduplicate membership and retain hidden hot agents", async () => {
  const world = new TimelineWorld();
  world.sync.replaceVisibleAgentIds("left-route", ["agent-a"]);
  world.sync.replaceVisibleAgentIds("right-route", ["agent-a", "agent-b"]);
  world.sync.setConnected(true);
  const combined = await world.nextMembership();
  combined.succeed();
  const [agentA, agentB] = await Promise.all([
    world.nextFetch("agent-a"),
    world.nextFetch("agent-b"),
  ]);
  agentA.respond({ hasNewer: false });
  agentB.respond({ hasNewer: false });

  world.sync.replaceVisibleAgentIds("left-route", []);
  world.expectNoPendingMembership();
  world.sync.replaceVisibleAgentIds("right-route", ["agent-b"]);

  expect(combined.agentIds).toEqual(["agent-a", "agent-b"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
});

test("a failed catch-up reports once and retries through the explicit retry policy", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const failed = await world.nextFetch("agent-a");
  failed.fail("timeline unavailable");
  const [error, retryCatchUp] = await Promise.all([world.nextError(), world.nextRetry()]);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");

  retryCatchUp();
  const retry = await world.nextFetch("agent-a");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");
  retry.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  expect({ error, retryDirection: retry.request.direction }).toEqual({
    error: "timeline unavailable",
    retryDirection: "tail",
  });
  world.expectNoPendingMembership();
});

test("gap recovery supersedes completed catch-up and pages through the current tail", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const initial = await world.nextFetch("agent-a");
  initial.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 10 });
  const gapPage = await world.nextFetch("agent-a");
  gapPage.respond({ hasNewer: true, seq: 15 });
  const finalPage = await world.nextFetch("agent-a");
  finalPage.respond({ hasNewer: false });

  expect([gapPage.request, finalPage.request]).toEqual([
    {
      direction: "after",
      cursor: { epoch: "epoch-agent-a", seq: 10 },
      limit: 40,
      projection: "projected",
    },
    {
      direction: "after",
      cursor: { epoch: "epoch-agent-a", seq: 15 },
      limit: 40,
      projection: "projected",
    },
  ]);
});

test("repeated recovery for the same running gap reuses the in-flight fetch", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const initial = await world.nextFetch("agent-a");
  initial.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  const cursor = { epoch: "epoch-agent-a", endSeq: 10 };
  world.sync.recoverGap("agent-a", cursor);
  const gapPage = await world.nextFetch("agent-a");
  world.sync.recoverGap("agent-a", cursor);

  world.expectNoPendingFetch();
  gapPage.respond({ hasNewer: false });
});

test("membership failure autonomously retries without another visibility declaration", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const failed = await world.nextMembership();
  failed.fail("subscription unavailable");
  const [error, retryMembership] = await Promise.all([world.nextError(), world.nextRetry()]);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");

  retryMembership();
  const retry = await world.nextMembership();
  retry.succeed();
  const catchUp = await world.nextFetch("agent-a");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");
  catchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  expect({ error, failed: failed.agentIds, retry: retry.agentIds }).toEqual({
    error: "subscription unavailable",
    failed: ["agent-a"],
    retry: ["agent-a"],
  });
});

test("backgrounding preserves the hot membership without catch-up on return", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const agentAMembership = await world.nextMembership();
  agentAMembership.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const agentBMembership = await world.nextMembership();
  agentBMembership.succeed();
  const agentBCatchUp = await world.nextFetch("agent-b");
  agentBCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  world.sync.setActive(false);
  world.expectNoPendingMembership();
  world.elapse(60_000);
  world.sync.setActive(true);

  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
});

test("stale membership retry cannot overwrite a newer effective set", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const failed = await world.nextMembership();
  failed.fail("subscription unavailable");
  const staleRetry = await world.nextRetry();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const current = await world.nextMembership();
  staleRetry();
  current.succeed();
  const [agentA, agentB] = await Promise.all([
    world.nextFetch("agent-a"),
    world.nextFetch("agent-b"),
  ]);
  agentA.respond({ hasNewer: false });
  agentB.respond({ hasNewer: false });

  expect(current.agentIds).toEqual(["agent-a", "agent-b"]);
  world.expectNoPendingMembership();
});

test("membership retry cannot run while disconnected", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const failed = await world.nextMembership();
  failed.fail("subscription unavailable");
  const disconnectedRetry = await world.nextRetry();

  world.sync.setConnected(false);
  disconnectedRetry();
  world.expectNoPendingMembership();
  world.sync.setConnected(true);
  const restored = await world.nextMembership();
  restored.succeed();
  const catchUp = await world.nextFetch("agent-a");
  catchUp.respond({ hasNewer: false });

  expect(restored.agentIds).toEqual(["agent-a"]);
});

test("returning to a hot hidden agent stays live after inactivity", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const initialMembership = await world.nextMembership();
  initialMembership.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const expandedMembership = await world.nextMembership();
  expandedMembership.succeed();
  const agentBCatchUp = await world.nextFetch("agent-b");
  agentBCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  world.elapse(60_000);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);

  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
});

test("the hot set evicts the least-recent hidden agent and promotes revisited agents", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"]) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const membership = await world.nextMembership();
    membership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
    await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus(agentId)).toBe("ready"));
  }

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-f"]);
  const eviction = await world.nextMembership();
  eviction.succeed();
  const agentFCatchUp = await world.nextFetch("agent-f");
  agentFCatchUp.respond({ hasNewer: false });
  expect(eviction.agentIds).toEqual(["agent-b", "agent-c", "agent-d", "agent-e", "agent-f"]);

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const restoreEvicted = await world.nextMembership();
  restoreEvicted.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });
  expect(restoreEvicted.agentIds).toEqual(["agent-a", "agent-b", "agent-d", "agent-e", "agent-f"]);
});

test("visible agents are never evicted when they exceed the hot-set limit", async () => {
  const world = new TimelineWorld();
  const visible = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"];
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", visible);
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUps = await Promise.all(visible.map((agentId) => world.nextFetch(agentId)));
  for (const catchUp of catchUps) catchUp.respond({ hasNewer: false });

  expect(membership.agentIds).toEqual(visible);

  world.sync.replaceVisibleAgentIds("workspace", visible.slice(0, 5));
  const hiddenEviction = await world.nextMembership();
  hiddenEviction.succeed();
  expect(hiddenEviction.agentIds).toEqual(visible.slice(0, 5));
});

test("disconnect clears hidden hot agents before reconnecting the visible set", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const agentAMembership = await world.nextMembership();
  agentAMembership.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const agentBMembership = await world.nextMembership();
  agentBMembership.succeed();
  const agentBCatchUp = await world.nextFetch("agent-b");
  agentBCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  world.sync.setConnected(false);
  world.expectNoPendingMembership();
  world.sync.setConnected(true);
  const restored = await world.nextMembership();
  restored.succeed();
  const restoredCatchUp = await world.nextFetch("agent-b");
  restoredCatchUp.respond({ hasNewer: false });

  expect(restored.agentIds).toEqual(["agent-b"]);

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const reopened = await world.nextMembership();
  reopened.succeed();
  const reopenedCatchUp = await world.nextFetch("agent-a");
  reopenedCatchUp.respond({ hasNewer: false });
  expect(reopened.agentIds).toEqual(["agent-a", "agent-b"]);
});

test("legacy delivery skips subscription RPCs while retaining visibility catch-up and gap recovery", async () => {
  const world = new TimelineWorld();
  world.sync.setDeliveryMode("legacy");
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  world.sync.setConnected(true);

  world.expectNoPendingMembership();
  const initial = await world.nextFetch("agent-a");
  initial.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 10 });
  const recovery = await world.nextFetch("agent-a");
  recovery.respond({ hasNewer: false });

  expect(recovery.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 10 },
    limit: 40,
    projection: "projected",
  });
});

test("legacy delivery catches up after returning to a view or foreground", async () => {
  const world = new TimelineWorld();
  world.sync.setDeliveryMode("legacy");
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const firstAgentA = await world.nextFetch("agent-a");
  firstAgentA.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const agentB = await world.nextFetch("agent-b");
  agentB.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const secondAgentA = await world.nextFetch("agent-a");
  secondAgentA.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.setActive(false);
  world.sync.setActive(true);
  const foregroundAgentA = await world.nextFetch("agent-a");
  foregroundAgentA.respond({ hasNewer: false });

  world.expectNoPendingMembership();
});

test("switching from legacy to selective delivery publishes membership and catches up once", async () => {
  const world = new TimelineWorld();
  world.sync.setDeliveryMode("legacy");
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  world.sync.setConnected(true);
  const legacyCatchUp = await world.nextFetch("agent-a");
  legacyCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.setDeliveryMode("selective");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("pending");
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUp = await world.nextFetch("agent-a");
  catchUp.respond({ hasNewer: false });

  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  expect(membership.agentIds).toEqual(["agent-a"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
});
