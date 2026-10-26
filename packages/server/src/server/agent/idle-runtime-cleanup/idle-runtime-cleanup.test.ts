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
  admitClose: (() => Promise<void>) | undefined;
  finishClose: (() => Promise<void>) | undefined;
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
        await this.admitClose?.();
        if (!eligible()) return false;
        this.closed = true;
        await this.finishClose?.();
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

test("the live host switch retains eligible runtimes and re-enables with their existing idle clocks", async () => {
  const s = scenario();
  s.cleanup.setEnabled(false);
  expect((await s.sweep(61)).collected).toEqual([]);
  expect(s.runtime.closed).toBe(false);
  s.cleanup.setEnabled(true);
  s.tick();
  expect((await s.cleanup.sweep()).collected).toHaveLength(1);
});

test.each([false, true])(
  "disabling during a probe invalidates the sweep (re-enable: %s)",
  async (reEnable) => {
    const s = scenario();
    const probe = deferred<boolean>();
    s.runtime.probe = () => probe.promise;
    const collecting = s.sweep(61);
    s.cleanup.setEnabled(false);
    if (reEnable) s.cleanup.setEnabled(true);
    probe.resolve(true);
    expect((await collecting).collected).toEqual([]);
    expect(s.runtime.closed).toBe(false);
    s.cleanup.setEnabled(true);
    expect((await s.sweep(62)).collected).toHaveLength(1);
  },
);

test.each([false, true])(
  "disabling while waiting for lifecycle admission prevents closure (re-enable: %s)",
  async (reEnable) => {
    const s = scenario();
    const admitted = deferred<void>();
    const waiting = deferred<void>();
    s.runtime.admitClose = () => {
      waiting.resolve();
      return admitted.promise;
    };
    const collecting = s.sweep(61);
    await waiting.promise;
    s.cleanup.setEnabled(false);
    if (reEnable) s.cleanup.setEnabled(true);
    admitted.resolve();
    expect((await collecting).collected).toEqual([]);
    expect(s.runtime.closed).toBe(false);
    s.cleanup.setEnabled(true);
    expect((await s.sweep(62)).collected).toHaveLength(1);
  },
);

test.each(["veto", "error"])(
  "an invalidated provider %s does not reset the idle clock",
  async (outcome) => {
    const s = scenario();
    const probe = deferred<boolean>();
    s.runtime.probe = async () => {
      await probe.promise;
      if (outcome === "error") throw new Error("Old probe failed");
      return false;
    };
    const collecting = s.sweep(61);
    s.cleanup.setEnabled(false);
    s.cleanup.setEnabled(true);
    probe.resolve(false);
    expect(await collecting).toEqual({ collected: [], failures: [] });
    s.runtime.probe = async () => true;
    expect((await s.sweep(62)).collected).toHaveLength(1);
  },
);

test("disabling lets a started close finish but prevents the next closure in that sweep", async () => {
  const s = scenario();
  const sibling = new Runtime("sibling");
  s.runtimes.push(sibling);
  const closing = deferred<void>();
  const finished = deferred<void>();
  s.runtime.finishClose = () => {
    closing.resolve();
    return finished.promise;
  };
  const collecting = s.sweep(61);
  await closing.promise;
  expect(s.runtime.closed).toBe(true);
  s.cleanup.setEnabled(false);
  finished.resolve();
  expect((await collecting).collected).toEqual([
    { agentId: "agent", provider: "test", sessionId: "agent" },
  ]);
  expect(sibling.closed).toBe(false);
  s.cleanup.setEnabled(true);
  expect((await s.sweep(62)).collected).toEqual([
    { agentId: "sibling", provider: "test", sessionId: "sibling" },
  ]);
});
