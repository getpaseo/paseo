import type { AgentProfile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { createAgentProfileWriteQueue } from "./profile-write-queue";

function profile(id: string, name = id): AgentProfile {
  return { id, name, provider: "claude", model: "claude-opus-5" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createAgentProfileWriteQueue", () => {
  it("serializes overlapping appends on the same host so both profiles persist", async () => {
    const queue = createAgentProfileWriteQueue();
    let stored: AgentProfile[] = [profile("p0")];
    const firstGate = deferred<void>();
    const writes: string[][] = [];

    const write = async (next: AgentProfile[]) => {
      writes.push(next.map((entry) => entry.id));
      if (writes.length === 1) {
        await firstGate.promise;
      }
      stored = next;
      return stored;
    };

    const first = queue.enqueue("host-a", {
      readCurrent: () => stored,
      write,
      updater: (current) => [...current, profile("p1")],
    });
    const second = queue.enqueue("host-a", {
      readCurrent: () => stored,
      write,
      updater: (current) => [...current, profile("p2")],
    });

    // Wait a microtask so the first write is in flight before releasing it.
    await Promise.resolve();
    expect(writes).toEqual([["p0", "p1"]]);

    firstGate.resolve();
    await expect(first).resolves.toEqual([profile("p0"), profile("p1")]);
    await expect(second).resolves.toEqual([profile("p0"), profile("p1"), profile("p2")]);
    expect(writes).toEqual([
      ["p0", "p1"],
      ["p0", "p1", "p2"],
    ]);
    expect(stored.map((entry) => entry.id)).toEqual(["p0", "p1", "p2"]);
  });

  it("removes only the undone profile when Undo overlaps another in-flight save", async () => {
    const queue = createAgentProfileWriteQueue();
    let stored: AgentProfile[] = [profile("p0"), profile("p1")];
    const saveGate = deferred<void>();

    const appendSecond = queue.enqueue("host-a", {
      readCurrent: () => stored,
      write: async (next) => {
        await saveGate.promise;
        stored = next;
        return stored;
      },
      updater: (current) => [...current, profile("p2")],
    });

    const undoFirst = queue.enqueue("host-a", {
      readCurrent: () => stored,
      write: async (next) => {
        stored = next;
        return stored;
      },
      updater: (current) => current.filter((entry) => entry.id !== "p1"),
    });

    saveGate.resolve();
    await appendSecond;
    await undoFirst;

    expect(stored.map((entry) => entry.id)).toEqual(["p0", "p2"]);
  });

  it("recovers after a rejected write so subsequent mutations still run", async () => {
    const queue = createAgentProfileWriteQueue();
    let stored: AgentProfile[] = [profile("p0")];

    const failing = queue.enqueue("host-a", {
      readCurrent: () => stored,
      write: async () => {
        throw new Error("network blip");
      },
      updater: (current) => [...current, profile("p1")],
    });

    const succeeding = queue.enqueue("host-a", {
      readCurrent: () => stored,
      write: async (next) => {
        stored = next;
        return stored;
      },
      updater: (current) => [...current, profile("p2")],
    });

    await expect(failing).rejects.toThrow("network blip");
    await expect(succeeding).resolves.toEqual([profile("p0"), profile("p2")]);
  });

  it("skips writing when current profiles are unloaded or the updater returns null", async () => {
    const queue = createAgentProfileWriteQueue();
    let writeCalls = 0;

    const unloaded = await queue.enqueue("host-a", {
      readCurrent: () => null,
      write: async (next) => {
        writeCalls += 1;
        return next;
      },
      updater: (current) => [...current, profile("p1")],
    });
    expect(unloaded).toBeNull();

    const noop = await queue.enqueue("host-a", {
      readCurrent: () => [profile("p0")],
      write: async (next) => {
        writeCalls += 1;
        return next;
      },
      updater: () => null,
    });
    expect(noop).toBeNull();
    expect(writeCalls).toBe(0);
  });

  it("does not block writes to a different host", async () => {
    const queue = createAgentProfileWriteQueue();
    const hostAGate = deferred<void>();
    let hostA: AgentProfile[] = [];
    let hostB: AgentProfile[] = [];

    const writeA = queue.enqueue("host-a", {
      readCurrent: () => hostA,
      write: async (next) => {
        await hostAGate.promise;
        hostA = next;
        return hostA;
      },
      updater: (current) => [...current, profile("a1")],
    });

    const writeB = await queue.enqueue("host-b", {
      readCurrent: () => hostB,
      write: async (next) => {
        hostB = next;
        return hostB;
      },
      updater: (current) => [...current, profile("b1")],
    });

    expect(writeB).toEqual([profile("b1")]);
    hostAGate.resolve();
    await expect(writeA).resolves.toEqual([profile("a1")]);
  });
});
