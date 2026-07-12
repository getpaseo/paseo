import { expect, test } from "vitest";
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
    readCursor: (agentId) => this.cursors.get(agentId),
    hasAuthoritativeHistory: (agentId) => this.authoritativeHistory.has(agentId),
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
    scheduleRetry: (retry) => {
      this.retries.push(retry);
      const waiter = this.retryWaiters.shift();
      if (waiter) waiter(this.retries.shift()!);
      return () => {
        const index = this.retries.indexOf(retry);
        if (index >= 0) this.retries.splice(index, 1);
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
  private readonly cursors = new Map<string, { epoch: string; startSeq: number; endSeq: number }>();
  private readonly authoritativeHistory = new Set<string>();
  private readonly errorWaiters: Array<(message: string) => void> = [];
  private readonly retries: Array<() => void> = [];
  private readonly retryWaiters: Array<(retry: () => void) => void> = [];

  setCursor(agentId: string, endSeq: number): void {
    this.cursors.set(agentId, { epoch: `epoch-${agentId}`, startSeq: 1, endSeq });
    this.authoritativeHistory.add(agentId);
  }

  setLiveCursor(agentId: string, endSeq: number): void {
    this.cursors.set(agentId, { epoch: `epoch-${agentId}`, startSeq: 1, endSeq });
  }

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
    const retry = this.retries.shift();
    if (retry) return Promise.resolve(retry);
    return new Promise((resolve) => this.retryWaiters.push(resolve));
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

test("uses a tail fetch when a live cursor is not authoritative", async () => {
  const world = new TimelineWorld();
  world.setLiveCursor("agent-a", 9);
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const fetch = await world.nextFetch("agent-a");
  expect(fetch.request).toEqual({ direction: "tail", limit: 100, projection: "projected" });
  fetch.respond({ hasNewer: false });
});

test("unchanged visible-set publication does not cancel paged catch-up", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const firstPage = await world.nextFetch("agent-a");

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a", "agent-a"]);
  firstPage.respond({ hasNewer: true, seq: 5 });
  const secondPage = await world.nextFetch("agent-a");
  secondPage.respond({ hasNewer: false });

  expect(secondPage.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 5 },
    limit: 100,
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

test("membership changes during acknowledgement never catch up the stale set", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const staleMembership = await world.nextMembership();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  staleMembership.succeed();
  const currentMembership = await world.nextMembership();
  currentMembership.succeed();
  const agentB = await world.nextFetch("agent-b");
  agentB.respond({ hasNewer: false });

  expect({ stale: staleMembership.agentIds, current: currentMembership.agentIds }).toEqual({
    stale: ["agent-a"],
    current: ["agent-b"],
  });
  world.expectNoPendingFetch();
});

test("removing one agent during paging cancels only that agent", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a", "agent-b"]);
  const initialMembership = await world.nextMembership();
  initialMembership.succeed();
  const [agentA, agentB] = await Promise.all([
    world.nextFetch("agent-a"),
    world.nextFetch("agent-b"),
  ]);

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const replacement = await world.nextMembership();
  agentA.respond({ hasNewer: true, seq: 4 });
  agentB.respond({ hasNewer: true, seq: 7 });
  const agentBNext = await world.nextFetch("agent-b");
  replacement.succeed();
  agentBNext.respond({ hasNewer: false });

  expect(replacement.agentIds).toEqual(["agent-b"]);
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
  stalePage.respond({ hasNewer: true, seq: 8 });
  world.sync.setConnected(true);
  const restoredMembership = await world.nextMembership();
  restoredMembership.succeed();
  const restoredPage = await world.nextFetch("agent-a");
  restoredPage.respond({ hasNewer: false });

  expect(restoredMembership.agentIds).toEqual(["agent-a"]);
  world.expectNoPendingFetch();
});

test("overlapping sources deduplicate membership and source removal preserves remaining views", async () => {
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
  const remaining = await world.nextMembership();
  remaining.succeed();

  expect({ combined: combined.agentIds, remaining: remaining.agentIds }).toEqual({
    combined: ["agent-a", "agent-b"],
    remaining: ["agent-b"],
  });
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

  retryCatchUp();
  const retry = await world.nextFetch("agent-a");
  retry.respond({ hasNewer: false });

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

  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 10 });
  const gapPage = await world.nextFetch("agent-a");
  gapPage.respond({ hasNewer: true, seq: 15 });
  const finalPage = await world.nextFetch("agent-a");
  finalPage.respond({ hasNewer: false });

  expect([gapPage.request, finalPage.request]).toEqual([
    {
      direction: "after",
      cursor: { epoch: "epoch-agent-a", seq: 10 },
      limit: 100,
      projection: "projected",
    },
    {
      direction: "after",
      cursor: { epoch: "epoch-agent-a", seq: 15 },
      limit: 100,
      projection: "projected",
    },
  ]);
});

test("membership failure autonomously retries without another visibility declaration", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const failed = await world.nextMembership();
  failed.fail("subscription unavailable");
  const [error, retryMembership] = await Promise.all([world.nextError(), world.nextRetry()]);

  retryMembership();
  const retry = await world.nextMembership();
  retry.succeed();
  const catchUp = await world.nextFetch("agent-a");
  catchUp.respond({ hasNewer: false });

  expect({ error, failed: failed.agentIds, retry: retry.agentIds }).toEqual({
    error: "subscription unavailable",
    failed: ["agent-a"],
    retry: ["agent-a"],
  });
});

test("background sends an empty set and foreground restores visible membership", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const initial = await world.nextMembership();
  initial.succeed();
  const initialCatchUp = await world.nextFetch("agent-a");
  initialCatchUp.respond({ hasNewer: false });

  world.sync.setActive(false);
  const background = await world.nextMembership();
  background.succeed();
  world.sync.setActive(true);
  const foreground = await world.nextMembership();
  foreground.succeed();
  const resumedCatchUp = await world.nextFetch("agent-a");
  resumedCatchUp.respond({ hasNewer: false });

  expect({ background: background.agentIds, foreground: foreground.agentIds }).toEqual({
    background: [],
    foreground: ["agent-a"],
  });
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
  const catchUp = await world.nextFetch("agent-b");
  catchUp.respond({ hasNewer: false });

  expect(current.agentIds).toEqual(["agent-b"]);
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
