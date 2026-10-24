import { expect, onTestFinished, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createIdleRuntimeCleanup, type RuntimeCleanupCandidate } from "./index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Runtime {
  readonly identity = {};
  busy = false;
  closed = false;
  resumable = true;
  activity = 0;
  parentAgentId: string | undefined;
  probe: (() => Promise<boolean>) | undefined;
  constructor(readonly id = "agent") {}
  capture(): RuntimeCleanupCandidate {
    const activity = this.activity;
    return {
      identity: this.identity,
      agentId: this.id,
      parentAgentId: this.parentAgentId,
      provider: "test",
      sessionId: this.resumable ? this.id : null,
      lastActivityAt: activity,
      isEligible: () => !this.closed && !this.busy && this.activity === activity,
      canStopRuntime: this.probe,
      closeIfEligible: async (eligible) => {
        if (!eligible()) return false;
        this.closed = true;
        return true;
      },
    };
  }
}
function scenario(enabled = true) {
  const runtime = new Runtime();
  const runtimes = [runtime];
  let time = 0;
  let protectedCaller = false;
  let tick!: () => void;
  const cleanup = createIdleRuntimeCleanup({
    enabled,
    logger: createTestLogger(),
    now: () => time,
    runtimes: () => runtimes.filter((item) => !item.closed).map((item) => item.capture()),
    isProtected: () => protectedCaller,
    schedule: (callback, interval) => {
      expect(interval).toBe(60_000);
      tick = callback;
      return () => {};
    },
  });
  onTestFinished(() => cleanup.close());
  return {
    runtime,
    runtimes,
    cleanup,
    tick: () => tick(),
    protect: (value: boolean) => {
      protectedCaller = value;
    },
    sweep: (minutes: number) => {
      time = minutes * 60_000;
      return cleanup.sweep();
    },
  };
}

test("a runtime without a provider check is collected at exactly one hour", async () => {
  const s = scenario();
  expect((await s.sweep(59)).collected).toEqual([]);
  expect((await s.sweep(60)).collected).toEqual([
    { agentId: "agent", provider: "test", sessionId: "agent" },
  ]);
});

test("activity restarts the single one-hour idle period", async () => {
  const s = scenario();
  await s.sweep(59);
  s.runtime.activity = 59 * 60_000;
  expect((await s.sweep(118)).collected).toEqual([]);
  expect((await s.sweep(119)).collected).toHaveLength(1);
});

test.each(["foreground", "finish subscription"])(
  "a positive provider check cannot override %s",
  async (blocker) => {
    const s = scenario();
    let calls = 0;
    s.runtime.probe = async () => {
      calls++;
      return true;
    };
    if (blocker === "foreground") s.runtime.busy = true;
    else s.protect(true);
    expect((await s.sweep(61)).collected).toEqual([]);
    expect(calls).toBe(0);
    s.runtime.busy = false;
    s.protect(false);
    expect((await s.sweep(62)).collected).toEqual([]);
    expect((await s.sweep(121)).collected).toEqual([]);
    expect((await s.sweep(122)).collected).toHaveLength(1);
  },
);

test.each(["veto", "error"])(
  "a supported provider %s retains the runtime until a fresh idle hour passes",
  async (decision) => {
    const s = scenario();
    s.runtime.probe = async () => {
      if (decision === "error") throw new Error("Probe failed");
      return false;
    };
    const blocked = await s.sweep(61);
    expect(blocked.collected).toEqual([]);
    expect(blocked.failures).toHaveLength(decision === "error" ? 1 : 0);
    await s.sweep(119);
    s.runtime.probe = async () => true;
    expect((await s.sweep(120)).collected).toEqual([]);
    expect((await s.sweep(179)).collected).toEqual([]);
    expect((await s.sweep(180)).collected).toHaveLength(1);
  },
);

test("an idle managed descendant with provider-held work vetoes its parent", async () => {
  const s = scenario();
  const child = new Runtime("child");
  child.parentAgentId = s.runtime.id;
  child.probe = async () => false;
  s.runtimes.push(child);
  expect((await s.sweep(61)).collected).toEqual([]);
  child.probe = async () => true;
  expect((await s.sweep(62)).collected).toEqual([]);
  expect((await s.sweep(122)).collected).toHaveLength(2);
});

test("new caller protection during an async provider probe prevents stale collection", async () => {
  const s = scenario();
  const probe = deferred<boolean>();
  s.runtime.probe = () => probe.promise;
  const collecting = s.sweep(61);
  s.protect(true);
  probe.resolve(true);
  expect((await collecting).collected).toEqual([]);
  expect(s.runtime.closed).toBe(false);
  s.protect(false);
  expect((await s.sweep(62)).collected).toEqual([]);
  expect((await s.sweep(122)).collected).toHaveLength(1);
});

test("a supported provider timeout retains ownership even if it later returns true", async () => {
  const s = scenario();
  const probe = deferred<boolean>();
  s.runtime.probe = () => probe.promise;
  const result = await s.sweep(61);
  expect(result.collected).toEqual([]);
  expect(result.failures[0]?.error).toEqual(new Error("Runtime safety probe timed out for agent"));
  probe.resolve(true);
  expect((await s.sweep(62)).collected).toEqual([]);
  expect(s.runtime.closed).toBe(false);
}, 15_000);

test("the host opt-out disables explicit sweeps and scheduled ticks", async () => {
  const s = scenario(false);
  let calls = 0;
  s.runtime.probe = async () => {
    calls++;
    return true;
  };
  expect((await s.sweep(61)).collected).toEqual([]);
  s.tick();
  await s.cleanup.close();
  expect(calls).toBe(0);
  expect(s.runtime.closed).toBe(false);
});

test("a managed descendant without persistence still protects its parent while working", async () => {
  const s = scenario();
  const child = new Runtime("initializing-child");
  child.parentAgentId = s.runtime.id;
  child.resumable = false;
  child.busy = true;
  s.runtimes.push(child);
  expect((await s.sweep(61)).collected).toEqual([]);
  child.busy = false;
  expect((await s.sweep(62)).collected).toEqual([]);
  expect((await s.sweep(122)).collected).toEqual([
    { agentId: "agent", provider: "test", sessionId: "agent" },
  ]);
  expect(child.closed).toBe(false);
});
