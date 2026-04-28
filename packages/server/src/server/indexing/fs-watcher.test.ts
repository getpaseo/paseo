import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";

import { WorkspaceFsWatcher, WorkspaceFsWatcherRegistry } from "./fs-watcher.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeFakeFactory() {
  const calls: Array<(rel: string) => void> = [];
  let closeCount = 0;
  return {
    factory: (_cwd: string, onChange: (rel: string) => void) => {
      calls.push(onChange);
      return {
        close() {
          closeCount += 1;
        },
      };
    },
    callsCount: () => calls.length,
    fire: (rel: string) => calls.at(-1)?.(rel),
    closeCount: () => closeCount,
  };
}

describe("WorkspaceFsWatcher", () => {
  it("debounces multiple changes into a single emission", () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory();
    const watcher = new WorkspaceFsWatcher({
      logger: pino({ enabled: false }),
      workspaceId: "ws1",
      cwd: "/repo",
      debounceMs: 100,
      watchFactory: fake.factory,
    });
    const events: Array<{ workspaceId: string; changedPaths: string[] }> = [];
    watcher.on("change", (info) => events.push(info));
    watcher.start();
    fake.fire("src/a.ts");
    fake.fire("src/b.ts");
    fake.fire("src/c.ts");
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(99);
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.changedPaths.sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("ignores configured patterns", () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory();
    const watcher = new WorkspaceFsWatcher({
      logger: pino({ enabled: false }),
      workspaceId: "ws1",
      cwd: "/repo",
      debounceMs: 50,
      ignorePatterns: ["node_modules/", ".code-review-graph/"],
      watchFactory: fake.factory,
    });
    const events: Array<{ workspaceId: string; changedPaths: string[] }> = [];
    watcher.on("change", (info) => events.push(info));
    watcher.start();
    fake.fire("node_modules/foo/index.js");
    fake.fire(".code-review-graph/db.sqlite");
    fake.fire("src/x.ts");
    vi.advanceTimersByTime(60);
    expect(events).toHaveLength(1);
    expect(events[0]?.changedPaths).toEqual(["src/x.ts"]);
  });

  it("pulse() force-flushes pending changes immediately", () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory();
    const watcher = new WorkspaceFsWatcher({
      logger: pino({ enabled: false }),
      workspaceId: "ws1",
      cwd: "/repo",
      debounceMs: 1000,
      watchFactory: fake.factory,
    });
    const events: Array<{ workspaceId: string; changedPaths: string[] }> = [];
    watcher.on("change", (info) => events.push(info));
    watcher.start();
    fake.fire("src/a.ts");
    watcher.pulse();
    expect(events).toHaveLength(1);
  });

  it("stop() cancels pending debounce and closes the watcher", () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory();
    const watcher = new WorkspaceFsWatcher({
      logger: pino({ enabled: false }),
      workspaceId: "ws1",
      cwd: "/repo",
      debounceMs: 100,
      watchFactory: fake.factory,
    });
    const events: Array<{ workspaceId: string; changedPaths: string[] }> = [];
    watcher.on("change", (info) => events.push(info));
    watcher.start();
    fake.fire("src/a.ts");
    watcher.stop();
    vi.advanceTimersByTime(500);
    expect(events).toHaveLength(0);
    expect(fake.closeCount()).toBe(1);
  });

  it("logs and skips when factory returns null (recursive unsupported)", () => {
    const watcher = new WorkspaceFsWatcher({
      logger: pino({ enabled: false }),
      workspaceId: "ws1",
      cwd: "/repo",
      watchFactory: () => null,
    });
    expect(() => watcher.start()).not.toThrow();
    expect(() => watcher.stop()).not.toThrow();
  });

  it("emits errors via the error channel", () => {
    const watcher = new WorkspaceFsWatcher({
      logger: pino({ enabled: false }),
      workspaceId: "ws1",
      cwd: "/repo",
      watchFactory: () => {
        throw new Error("EACCES");
      },
    });
    const errors: Error[] = [];
    watcher.on("error", (err) => errors.push(err));
    watcher.start();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("EACCES");
  });

  it("isolates listener exceptions", () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory();
    const watcher = new WorkspaceFsWatcher({
      logger: pino({ enabled: false }),
      workspaceId: "ws1",
      cwd: "/repo",
      debounceMs: 50,
      watchFactory: fake.factory,
    });
    const goodEvents: number[] = [];
    watcher.on("change", () => {
      throw new Error("bad");
    });
    watcher.on("change", () => goodEvents.push(1));
    watcher.start();
    fake.fire("src/a.ts");
    vi.advanceTimersByTime(60);
    expect(goodEvents).toEqual([1]);
  });
});

describe("WorkspaceFsWatcherRegistry", () => {
  it("starts/stops watchers per workspace and tracks size", () => {
    const fake = makeFakeFactory();
    const reg = new WorkspaceFsWatcherRegistry({
      logger: pino({ enabled: false }),
      factory: (d) => new WorkspaceFsWatcher({ ...d, debounceMs: 10, watchFactory: fake.factory }),
    });
    expect(reg.size()).toBe(0);
    reg.set("ws1", "/repo1", () => undefined);
    reg.set("ws2", "/repo2", () => undefined);
    expect(reg.size()).toBe(2);
    expect(reg.has("ws1")).toBe(true);
    reg.clear("ws1");
    expect(reg.size()).toBe(1);
    expect(fake.closeCount()).toBe(1);
    reg.closeAll();
    expect(reg.size()).toBe(0);
    expect(fake.closeCount()).toBe(2);
  });

  it("set() replaces an existing watcher for the same workspace", () => {
    const fake = makeFakeFactory();
    const reg = new WorkspaceFsWatcherRegistry({
      logger: pino({ enabled: false }),
      factory: (d) => new WorkspaceFsWatcher({ ...d, debounceMs: 10, watchFactory: fake.factory }),
    });
    reg.set("ws1", "/old", () => undefined);
    reg.set("ws1", "/new", () => undefined);
    expect(reg.size()).toBe(1);
    expect(fake.closeCount()).toBe(1);
  });

  it("forwards change events to the registered callback", () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory();
    const reg = new WorkspaceFsWatcherRegistry({
      logger: pino({ enabled: false }),
      factory: (d) => new WorkspaceFsWatcher({ ...d, debounceMs: 30, watchFactory: fake.factory }),
    });
    const events: Array<{ workspaceId: string; changedPaths: string[] }> = [];
    reg.set("ws1", "/repo", (info) => events.push(info));
    fake.fire("src/foo.ts");
    vi.advanceTimersByTime(40);
    expect(events).toEqual([{ workspaceId: "ws1", changedPaths: ["src/foo.ts"] }]);
  });
});
