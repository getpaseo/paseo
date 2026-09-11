import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { describe, expect, test } from "vitest";

import { createProcessSleepInhibitor, resolveInhibitorCommand } from "./backend.js";

function createLogger(): Logger {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger as unknown as Logger;
}

interface FakeChild extends EventEmitter {
  pid: number;
  killed: boolean;
  kill(): boolean;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function createSpawnRecorder() {
  const calls: { command: string; args: string[] }[] = [];
  const children: FakeChild[] = [];
  function spawn(command: string, args: string[]): ChildProcess {
    calls.push({ command, args });
    const child = createFakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  }
  return { calls, children, spawn: spawn as never };
}

describe("resolveInhibitorCommand", () => {
  test("watches the daemon pid on macOS so a crash cannot orphan caffeinate", () => {
    expect(resolveInhibitorCommand("darwin", 1234)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "1234"],
    });
  });

  test("blocks idle and sleep on Linux", () => {
    const resolved = resolveInhibitorCommand("linux", 1234);

    expect(resolved?.command).toBe("systemd-inhibit");
    expect(resolved?.args).toContain("--what=idle:sleep");
    expect(resolved?.args).toContain("--mode=block");
  });

  test("has no mechanism on Windows", () => {
    expect(resolveInhibitorCommand("win32", 1234)).toBeNull();
  });
});

describe("process sleep inhibitor", () => {
  test("spawns one helper and kills it on release", () => {
    const recorder = createSpawnRecorder();
    const inhibitor = createProcessSleepInhibitor({
      logger: createLogger(),
      spawn: recorder.spawn,
      platform: "darwin",
      pid: 99,
    });

    inhibitor.acquire();
    inhibitor.acquire();

    expect(recorder.calls).toEqual([{ command: "caffeinate", args: ["-i", "-w", "99"] }]);
    expect(inhibitor.isHeld()).toBe(true);

    inhibitor.release();

    expect(recorder.children[0]?.killed).toBe(true);
    expect(inhibitor.isHeld()).toBe(false);
  });

  test("reports unsupported on a platform with no mechanism", () => {
    const recorder = createSpawnRecorder();
    const inhibitor = createProcessSleepInhibitor({
      logger: createLogger(),
      spawn: recorder.spawn,
      platform: "win32",
      pid: 99,
    });

    inhibitor.acquire();

    expect(recorder.calls).toEqual([]);
    expect(inhibitor.isSupported()).toBe(false);
    expect(inhibitor.isHeld()).toBe(false);
  });

  test("stops claiming support once the helper binary turns out to be missing", () => {
    const recorder = createSpawnRecorder();
    const inhibitor = createProcessSleepInhibitor({
      logger: createLogger(),
      spawn: recorder.spawn,
      platform: "linux",
      pid: 99,
    });

    inhibitor.acquire();
    expect(inhibitor.isSupported()).toBe(true);

    const error: NodeJS.ErrnoException = new Error("spawn systemd-inhibit ENOENT");
    error.code = "ENOENT";
    recorder.children[0]?.emit("error", error);

    expect(inhibitor.isSupported()).toBe(false);
    expect(inhibitor.isHeld()).toBe(false);

    inhibitor.acquire();
    expect(recorder.calls).toHaveLength(1);
  });

  test("forgets a helper that exits on its own", () => {
    const recorder = createSpawnRecorder();
    const inhibitor = createProcessSleepInhibitor({
      logger: createLogger(),
      spawn: recorder.spawn,
      platform: "darwin",
      pid: 99,
    });

    inhibitor.acquire();
    recorder.children[0]?.emit("exit", 0, null);

    expect(inhibitor.isHeld()).toBe(false);

    inhibitor.acquire();
    expect(recorder.calls).toHaveLength(2);
  });
});
