import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import pino from "pino";

import { CrgProcessManager, type CrgProcessState, type CrgSpawnHandle } from "./process-manager.js";

class FakeChild extends EventEmitter {
  killed = false;
  killSignal: NodeJS.Signals | null = null;
  stdin = new EventEmitter() as unknown as NodeJS.WritableStream;
  stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  constructor(public pid: number) {
    super();
  }
  kill = (signal?: NodeJS.Signals): boolean => {
    this.killed = true;
    this.killSignal = signal ?? "SIGTERM";
    return true;
  };
  triggerExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("exit", code, signal);
  }
  triggerError(err: Error): void {
    this.emit("error", err);
  }
  asHandle(): CrgSpawnHandle {
    return this as unknown as CrgSpawnHandle;
  }
}

class FakeScheduler {
  pending: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];
  schedule = (fn: () => void, delayMs: number) => {
    const entry = { fn, delayMs, cancelled: false };
    this.pending.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };
  fireNext(): void {
    const entry = this.pending.shift();
    if (!entry) throw new Error("no pending restart");
    if (!entry.cancelled) entry.fn();
  }
}

function makeManager(opts: {
  binPath?: string | null;
  spawnImpl?: (cmd: string, args: string[]) => CrgSpawnHandle;
  scheduler?: FakeScheduler;
  maxConsecutiveFailures?: number;
}) {
  const scheduler = opts.scheduler ?? new FakeScheduler();
  const mgr = new CrgProcessManager({
    logger: pino({ enabled: false }),
    binPath: opts.binPath === undefined ? "/usr/bin/code-review-graph" : opts.binPath,
    spawn: opts.spawnImpl ?? (() => new FakeChild(123).asHandle()),
    scheduleRestart: scheduler.schedule,
    initialBackoffMs: 10,
    maxBackoffMs: 100,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 3,
  });
  return { mgr, scheduler };
}

describe("CrgProcessManager.start", () => {
  it("transitions stopped → starting → running and reports pid", () => {
    const states: CrgProcessState[] = [];
    const { mgr } = makeManager({});
    mgr.on("state", (s) => states.push(s));
    mgr.start();
    expect(states.map((s) => s.phase)).toEqual(["starting", "running"]);
    expect(mgr.getState().pid).toBe(123);
    expect(mgr.isRunning()).toBe(true);
  });

  it("immediately fails when binPath is null", () => {
    const { mgr } = makeManager({ binPath: null });
    mgr.start();
    const state = mgr.getState();
    expect(state.phase).toBe("failed");
    expect(state.lastError).toMatch(/not installed/i);
  });

  it("captures spawn errors and transitions to failed", () => {
    const { mgr } = makeManager({
      spawnImpl: () => {
        throw new Error("ENOENT");
      },
    });
    mgr.start();
    const state = mgr.getState();
    expect(state.phase).toBe("failed");
    expect(state.lastError).toBe("ENOENT");
  });

  it("ignores duplicate start calls when already running", () => {
    let count = 0;
    const { mgr } = makeManager({
      spawnImpl: () => {
        count += 1;
        return new FakeChild(count).asHandle();
      },
    });
    mgr.start();
    mgr.start();
    expect(count).toBe(1);
  });
});

describe("CrgProcessManager.stop", () => {
  it("kills the child and stays stopped without auto-restart", () => {
    const child = new FakeChild(123);
    const { mgr, scheduler } = makeManager({ spawnImpl: () => child.asHandle() });
    mgr.start();
    mgr.stop();
    expect(child.killed).toBe(true);
    expect(mgr.getState().phase).toBe("stopped");
    // Simulate the OS sending exit after kill — should still be stopped
    child.triggerExit(null, "SIGTERM");
    expect(mgr.getState().phase).toBe("stopped");
    expect(scheduler.pending).toHaveLength(0);
  });

  it("is a no-op when nothing is running", () => {
    const { mgr } = makeManager({ binPath: null });
    expect(() => mgr.stop()).not.toThrow();
  });
});

describe("CrgProcessManager auto-restart", () => {
  it("schedules a restart with exponential backoff after unexpected exit", () => {
    const child1 = new FakeChild(1);
    const child2 = new FakeChild(2);
    const child3 = new FakeChild(3);
    const handles = [child1, child2, child3];
    const { mgr, scheduler } = makeManager({
      spawnImpl: () => handles.shift()?.asHandle() as CrgSpawnHandle,
    });

    mgr.start();
    expect(mgr.getState().pid).toBe(1);

    child1.triggerExit(1, null);
    expect(mgr.getState().phase).toBe("restarting");
    expect(scheduler.pending[0]?.delayMs).toBe(10);

    scheduler.fireNext();
    expect(mgr.isRunning()).toBe(true);
    expect(mgr.getState().pid).toBe(2);

    child2.triggerExit(1, null);
    expect(scheduler.pending[0]?.delayMs).toBe(20); // 10 * 2^(2-1)

    scheduler.fireNext();
    expect(mgr.getState().pid).toBe(3);
  });

  it("transitions to failed after maxConsecutiveFailures", () => {
    const handles = Array.from({ length: 5 }, (_, i) => new FakeChild(i + 1));
    const { mgr, scheduler } = makeManager({
      spawnImpl: () => handles.shift()?.asHandle() as CrgSpawnHandle,
      maxConsecutiveFailures: 3,
    });
    mgr.start();
    const triggerCurrentChildExit = () => {
      const child = (mgr as unknown as { child: FakeChild | null }).child;
      child?.triggerExit(1, null);
    };
    triggerCurrentChildExit(); // failure 1 → restarting
    expect(mgr.getState().phase).toBe("restarting");
    scheduler.fireNext();
    triggerCurrentChildExit(); // failure 2 → restarting
    expect(mgr.getState().phase).toBe("restarting");
    scheduler.fireNext();
    triggerCurrentChildExit(); // failure 3 → failed
    expect(mgr.getState().phase).toBe("failed");
    expect(scheduler.pending).toHaveLength(0);
  });

  it("clamps backoff to maxBackoffMs", () => {
    const handles = Array.from({ length: 8 }, (_, i) => new FakeChild(i + 1));
    const { mgr, scheduler } = makeManager({
      spawnImpl: () => handles.shift()?.asHandle() as CrgSpawnHandle,
      maxConsecutiveFailures: 100,
    });
    mgr.start();
    // Repeatedly fail a few times — but we need the manager to know about the
    // failing child each round. Easier: directly access manager's child each
    // cycle.
    const triggerCurrentChildExit = () => {
      const child = (mgr as unknown as { child: FakeChild | null }).child;
      child?.triggerExit(1, null);
    };
    triggerCurrentChildExit();
    expect(scheduler.pending[0]?.delayMs).toBe(10);
    scheduler.fireNext();
    triggerCurrentChildExit();
    expect(scheduler.pending[0]?.delayMs).toBe(20);
    scheduler.fireNext();
    triggerCurrentChildExit();
    expect(scheduler.pending[0]?.delayMs).toBe(40);
    scheduler.fireNext();
    triggerCurrentChildExit();
    expect(scheduler.pending[0]?.delayMs).toBe(80);
    scheduler.fireNext();
    triggerCurrentChildExit();
    // 10 * 2^4 = 160 → clamped to 100
    expect(scheduler.pending[0]?.delayMs).toBe(100);
  });
});

describe("CrgProcessManager.restart", () => {
  it("kills the running child, increments restart count, and starts again", () => {
    const child1 = new FakeChild(1);
    const child2 = new FakeChild(2);
    const handles = [child1, child2];
    const { mgr } = makeManager({
      spawnImpl: () => handles.shift()?.asHandle() as CrgSpawnHandle,
    });
    mgr.start();
    expect(mgr.getState().restartCount).toBe(0);
    mgr.restart();
    expect(child1.killed).toBe(true);
    expect(mgr.isRunning()).toBe(true);
    expect(mgr.getState().pid).toBe(2);
    expect(mgr.getState().restartCount).toBe(1);
  });
});

describe("CrgProcessManager.getChildStreams", () => {
  it("returns streams only while a child is attached", () => {
    const child = new FakeChild(1);
    const { mgr } = makeManager({ spawnImpl: () => child.asHandle() });
    expect(mgr.getChildStreams()).toBeNull();
    mgr.start();
    const streams = mgr.getChildStreams();
    expect(streams).not.toBeNull();
    expect(streams?.stdout).toBe(child.stdout);
    expect(streams?.stdin).toBe(child.stdin);
    mgr.stop();
    expect(mgr.getChildStreams()).toBeNull();
  });
});

describe("CrgProcessManager.resetFailures", () => {
  it("clears the auto-restart failure counter so the cap resets", () => {
    const handles = Array.from({ length: 6 }, (_, i) => new FakeChild(i + 1));
    const { mgr, scheduler } = makeManager({
      spawnImpl: () => handles.shift()?.asHandle() as CrgSpawnHandle,
      maxConsecutiveFailures: 3,
    });
    mgr.start();
    const triggerCurrentChildExit = () => {
      const child = (mgr as unknown as { child: FakeChild | null }).child;
      child?.triggerExit(1, null);
    };
    triggerCurrentChildExit(); // failure 1 → restarting
    scheduler.fireNext();
    mgr.resetFailures(); // simulate MCP handshake OK
    triggerCurrentChildExit(); // failure 1 again (reset worked)
    expect(mgr.getState().phase).toBe("restarting");
    scheduler.fireNext();
    triggerCurrentChildExit(); // failure 2
    expect(mgr.getState().phase).toBe("restarting");
    scheduler.fireNext();
    triggerCurrentChildExit(); // failure 3 → failed
    expect(mgr.getState().phase).toBe("failed");
  });
});

describe("CrgProcessManager events", () => {
  let states: CrgProcessState[];
  let mgr: CrgProcessManager;

  beforeEach(() => {
    states = [];
  });

  it("forwards stdout and stderr", () => {
    const child = new FakeChild(1);
    const got = { stdout: "", stderr: "" };
    ({ mgr } = makeManager({ spawnImpl: () => child.asHandle() }));
    mgr.on("stdout", (chunk) => {
      got.stdout += chunk.toString();
    });
    mgr.on("stderr", (chunk) => {
      got.stderr += chunk.toString();
    });
    mgr.start();
    (child.stdout as unknown as EventEmitter).emit("data", Buffer.from("hello "));
    (child.stderr as unknown as EventEmitter).emit("data", Buffer.from("oops"));
    expect(got.stdout).toBe("hello ");
    expect(got.stderr).toBe("oops");
  });

  it("emits state change events on every transition", () => {
    const child = new FakeChild(1);
    ({ mgr } = makeManager({ spawnImpl: () => child.asHandle() }));
    mgr.on("state", (s) => states.push(s));
    mgr.start();
    mgr.stop();
    expect(states.map((s) => s.phase)).toEqual(["starting", "running", "stopped"]);
  });
});
