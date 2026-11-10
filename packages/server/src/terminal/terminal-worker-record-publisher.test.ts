import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createTerminalWorkerRecordPublisher } from "./terminal-worker-record-publisher.js";
import type { TerminalWorkerRecord } from "./terminal-worker-record.js";

const record: TerminalWorkerRecord = {
  recordId: "worker",
  pid: 123,
  bootId: null,
  createdAt: "now",
  identity: { startedAt: "now", commandLine: "worker" },
  protocolVersion: 1,
  paseoVersion: "test",
  socketPath: "socket",
  secret: "secret",
  terminals: [{ id: "terminal", pid: 124, startedAt: "now" }],
};

describe("live worker record publication", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])(
    "publishes the latest state after %s contention clears",
    async (code) => {
      let locked = true;
      const written: TerminalWorkerRecord[] = [];
      const publisher = createTerminalWorkerRecordPublisher((state) => {
        if (locked) throw Object.assign(new Error("reader holds record"), { code });
        written.push(state);
      });
      try {
        const creation = publisher.publish(record);
        const exited = { ...record, terminals: [] };
        const exit = publisher.publish(exited);
        expect(written).toEqual([]);
        locked = false;
        await Promise.all([creation, exit]);
        expect(written).toEqual([exited]);
      } finally {
        publisher.stop();
      }
    },
  );

  it("does not recreate a retired record when a reader releases it", async () => {
    let locked = true;
    const written: TerminalWorkerRecord[] = [];
    const publisher = createTerminalWorkerRecordPublisher((state) => {
      if (locked)
        throw Object.assign(new Error("reader holds record"), {
          code: "EPERM",
        });
      written.push(state);
    });
    const pending = publisher.publish(record);
    const rejected = expect(pending).rejects.toThrow("stopped");
    publisher.stop();
    locked = false;
    await rejected;
    await delay(50);
    expect(written).toEqual([]);
    await expect(publisher.publish(record)).rejects.toThrow("stopped");
  });

  it("reports permanent storage failures without retrying", async () => {
    const publisher = createTerminalWorkerRecordPublisher(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    await expect(publisher.publish(record)).rejects.toThrow("disk full");
    publisher.stop();
  });
});
