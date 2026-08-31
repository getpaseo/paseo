import { describe, expect, it } from "vitest";

import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { BoundedAgentTimelineHotStore } from "./bounded-agent-timeline-hot-store.js";
import {
  OrderedAgentTimelineDurableBuffer,
  TimelineDurableBufferBackpressureError,
  type TimelineDurableSink,
} from "./ordered-agent-timeline-durable-buffer.js";

describe("OrderedAgentTimelineDurableBuffer", () => {
  it("batches inserts in sequence per agent while allowing agents to drain independently", async () => {
    const writes: Array<{ agentId: string; seqs: number[] }> = [];
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        writes.push({ agentId, seqs: rows.map(({ seq }) => seq) });
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, { maxBatchRows: 8 });

    await Promise.all([
      buffer.insert("agent-a", row(1)),
      buffer.insert("agent-a", row(2)),
      buffer.insert("agent-b", row(7)),
    ]);

    expect(writes).toEqual(
      expect.arrayContaining([
        { agentId: "agent-a", seqs: [1, 2] },
        { agentId: "agent-b", seqs: [7] },
      ]),
    );
    expect(writes).toHaveLength(2);
  });

  it("does not serialize another agent behind a held durable batch", async () => {
    const releaseAgentA = deferred<void>();
    const agentAStarted = deferred<void>();
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId) => {
        if (agentId !== "agent-a") return;
        agentAStarted.resolve();
        await releaseAgentA.promise;
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink);

    const agentA = buffer.insert("agent-a", row(1));
    await agentAStarted.promise;
    await expect(buffer.insert("agent-b", row(1))).resolves.toBeUndefined();
    releaseAgentA.resolve();
    await agentA;
  });

  it("acknowledges durability only after the sink succeeds, before hot eviction", async () => {
    const durableWrite = deferred<void>();
    const writeStarted = deferred<void>();
    const hot = new BoundedAgentTimelineHotStore({ maxRows: 1, maxBytes: 10_000 });
    hot.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });
    const revision = hot.append("agent-1", row(1));
    hot.append("agent-1", row(2), { durable: true });
    const sink: TimelineDurableSink = {
      bulkInsert: async () => {
        writeStarted.resolve();
        await durableWrite.promise;
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, {
      onDurable: ({ agentId, revisions }) => {
        for (const durableRevision of revisions) {
          if (durableRevision) hot.acknowledgeDurable(agentId, durableRevision);
        }
      },
    });

    const completion = buffer.insert("agent-1", row(1), revision);
    await writeStarted.promise;
    expect(hot.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([1, 2]);
    durableWrite.resolve();
    await completion;
    expect(hot.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([2]);
  });

  it("does not let an old insert acknowledgement evict a newer pending update", async () => {
    const durableWrite = deferred<void>();
    const writeStarted = deferred<void>();
    const hot = new BoundedAgentTimelineHotStore({ maxRows: 1, maxBytes: 10_000 });
    hot.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });
    const insertedRevision = hot.append("agent-1", row(1));
    hot.append("agent-1", row(2), { durable: true });
    let holdInsert = true;
    const sink: TimelineDurableSink = {
      bulkInsert: async () => {
        if (!holdInsert) return;
        writeStarted.resolve();
        await durableWrite.promise;
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, {
      onDurable: ({ agentId, revisions }) => {
        for (const revision of revisions) {
          if (revision) hot.acknowledgeDurable(agentId, revision);
        }
      },
    });
    const inserted = buffer.insert("agent-1", row(1), insertedRevision);
    await writeStarted.promise;
    const updatedRow = { ...row(1), item: { type: "user_message" as const, text: "updated" } };
    const updatedRevision = hot.update("agent-1", updatedRow);

    holdInsert = false;
    durableWrite.resolve();
    await inserted;
    expect(hot.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([1, 2]);

    await buffer.update("agent-1", updatedRow, updatedRevision);
    expect(hot.snapshot("agent-1").rows).toEqual([row(2)]);
  });

  it("fails a sequence prefix without writing any later operation", async () => {
    const writes: number[][] = [];
    const failure = new Error("durable unavailable");
    let failWrites = true;
    const sink: TimelineDurableSink = {
      bulkInsert: async (_agentId, rows) => {
        writes.push(rows.map(({ seq }) => seq));
        if (failWrites) throw failure;
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, { maxBatchRows: 2 });

    const results = await Promise.allSettled([
      buffer.insert("agent-1", row(1)),
      buffer.insert("agent-1", row(2)),
      buffer.insert("agent-1", row(3)),
    ]);

    expect(writes).toEqual([[1, 2]]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await expect(buffer.insert("agent-1", row(4))).rejects.toBe(failure);
    expect(writes).toEqual([[1, 2]]);

    await buffer.reset("agent-1");
    failWrites = false;
    await Promise.all([
      buffer.insert("agent-1", row(1)),
      buffer.insert("agent-1", row(2)),
      buffer.insert("agent-1", row(3)),
    ]);
    expect(writes).toEqual([[1, 2], [1, 2], [3]]);
  });

  it("waits for an insert before writing an update for the same row", async () => {
    const insertWrite = deferred<void>();
    const insertStarted = deferred<void>();
    const writes: string[] = [];
    const sink: TimelineDurableSink = {
      bulkInsert: async () => {
        writes.push("insert-started");
        insertStarted.resolve();
        await insertWrite.promise;
        writes.push("insert-finished");
      },
      updateCommittedRow: async () => {
        writes.push("update");
      },
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink);

    const inserted = buffer.insert("agent-1", row(1));
    const updated = buffer.update("agent-1", {
      ...row(1),
      item: { type: "user_message", text: "updated" },
    });
    await insertStarted.promise;
    expect(writes).toEqual(["insert-started"]);
    insertWrite.resolve();
    await Promise.all([inserted, updated]);
    expect(writes).toEqual(["insert-started", "insert-finished", "update"]);
  });

  it("invalidates an in-flight completion when an agent buffer is discarded", async () => {
    const durableWrite = deferred<void>();
    const writeStarted = deferred<void>();
    let acknowledgements = 0;
    const sink: TimelineDurableSink = {
      bulkInsert: async () => {
        writeStarted.resolve();
        await durableWrite.promise;
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, {
      onDurable: () => {
        acknowledgements += 1;
      },
    });
    const completion = buffer.insert("agent-1", row(1));
    const observed = completion.then(
      () => "fulfilled" as const,
      (error: unknown) => error,
    );
    await writeStarted.promise;

    const discarded = buffer.discard("agent-1");
    let discardFinished = false;
    void discarded.then(() => {
      discardFinished = true;
      return undefined;
    });
    await expect(buffer.insert("agent-1", row(2))).rejects.toMatchObject({
      name: "TimelineDurableBufferDiscardedError",
    });
    expect(discardFinished).toBe(false);
    durableWrite.resolve();
    await discarded;

    await expect(observed).resolves.toMatchObject({
      name: "TimelineDurableBufferDiscardedError",
    });
    expect(acknowledgements).toBe(0);
    await buffer.reset("agent-1");
    await expect(buffer.insert("agent-1", row(1))).resolves.toBeUndefined();
  });

  it("splits batches by encoded bytes while allowing one oversized row", async () => {
    const writes: number[][] = [];
    const first = textRow(1, "😀".repeat(40));
    const second = textRow(2, "😀".repeat(40));
    const huge = textRow(3, "😀".repeat(400));
    const maxBatchBytes = Buffer.byteLength(JSON.stringify(first), "utf8") * 2 - 1;
    const sink: TimelineDurableSink = {
      bulkInsert: async (_agentId, rows) => {
        writes.push(rows.map(({ seq }) => seq));
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, {
      maxBatchRows: 10,
      maxBatchBytes,
    });

    await Promise.all([
      buffer.insert("agent-1", first),
      buffer.insert("agent-1", second),
      buffer.insert("agent-1", huge),
    ]);

    expect(writes).toEqual([[1], [2], [3]]);
  });

  it.each([
    { name: "row", maxPendingRows: 2, maxPendingBytes: 100_000, expectedPending: 2 },
    {
      name: "byte",
      maxPendingRows: 10,
      maxPendingBytes: Buffer.byteLength(JSON.stringify(row(1)), "utf8") * 2 - 1,
      expectedPending: 1,
    },
  ])("backpressures producers at the pending $name high-water mark", async (limits) => {
    const durableWrite = deferred<void>();
    const writeStarted = deferred<void>();
    const sink: TimelineDurableSink = {
      bulkInsert: async () => {
        writeStarted.resolve();
        await durableWrite.promise;
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, {
      maxPendingRows: limits.maxPendingRows,
      maxPendingBytes: limits.maxPendingBytes,
      maxBatchRows: 10,
    });
    const writes = Array.from({ length: limits.expectedPending }, (_, index) =>
      buffer.insert("agent-1", row(index + 1)),
    );
    const rejected = await buffer.insert("agent-1", row(limits.expectedPending + 1)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await writeStarted.promise;

    expect(buffer.metrics()).toMatchObject({
      agents: 1,
      pendingRows: limits.expectedPending,
      writableSignals: 1,
    });
    expect(rejected).toBeInstanceOf(TimelineDurableBufferBackpressureError);
    const flushed = buffer.flushAll();
    durableWrite.resolve();
    await Promise.all(writes);
    await flushed;
    await (rejected as TimelineDurableBufferBackpressureError).whenWritable;
    await buffer.insert("agent-1", row(limits.expectedPending + 1));
    expect(buffer.metrics()).toEqual({
      agents: 0,
      pendingRows: 0,
      pendingBytes: 0,
      writableSignals: 0,
      failedAgents: 0,
      discardedAgents: 0,
      acknowledgementFailures: 0,
    });
  });

  it("reports acknowledgement failure separately and continues durable writes", async () => {
    const writes: number[][] = [];
    const acknowledgementFailure = new Error("hot acknowledgement failed");
    let failAcknowledgement = true;
    const sink: TimelineDurableSink = {
      bulkInsert: async (_agentId, rows) => {
        writes.push(rows.map(({ seq }) => seq));
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, {
      onDurable: () => {
        if (!failAcknowledgement) return;
        failAcknowledgement = false;
        throw acknowledgementFailure;
      },
    });

    await expect(buffer.insert("agent-1", row(1))).rejects.toBe(acknowledgementFailure);
    await expect(buffer.insert("agent-1", row(2))).resolves.toBeUndefined();

    expect(writes).toEqual([[1], [2]]);
    expect(buffer.metrics()).toMatchObject({
      agents: 0,
      failedAgents: 0,
      acknowledgementFailures: 1,
    });
  });

  it("hard-bounds admitted work and coalesces backpressure and flush waiters", async () => {
    const durableWrite = deferred<void>();
    const writeStarted = deferred<void>();
    const sink: TimelineDurableSink = {
      bulkInsert: async () => {
        writeStarted.resolve();
        await durableWrite.promise;
      },
      updateCommittedRow: async () => undefined,
    };
    const buffer = new OrderedAgentTimelineDurableBuffer(sink, {
      maxPendingRows: 2,
      maxPendingBytes: 100_000,
      maxBatchRows: 2,
    });
    const accepted = [buffer.insert("agent-1", row(1)), buffer.insert("agent-1", row(2))];
    await writeStarted.promise;
    const excess = Array.from({ length: 1_000 }, (_, index) =>
      captureError(buffer.insert("agent-1", row(index + 3))),
    );
    const firstFlush = buffer.flush("agent-1");
    const secondFlush = buffer.flush("agent-1");
    try {
      expect(firstFlush).toBe(secondFlush);
      expect(buffer.metrics()).toMatchObject({
        agents: 1,
        pendingRows: 2,
        writableSignals: 1,
      });
    } finally {
      durableWrite.resolve();
    }
    const errors = await Promise.all(excess);
    await Promise.all(accepted);
    await firstFlush;
    expect(errors).toHaveLength(1_000);
    expect(errors.every((error) => error instanceof TimelineDurableBufferBackpressureError)).toBe(
      true,
    );
    const writableSignals = errors.map(
      (error) => (error as TimelineDurableBufferBackpressureError).whenWritable,
    );
    expect(new Set(writableSignals)).toHaveLength(1);
    await writableSignals[0];
    await expect(buffer.insert("agent-1", row(3))).resolves.toBeUndefined();
  });
});

function row(seq: number): AgentTimelineRow {
  return {
    seq,
    timestamp: "2026-08-31T12:00:00.000Z",
    item: { type: "user_message", text: `row-${seq}` },
  };
}

function textRow(seq: number, text: string): AgentTimelineRow {
  return { ...row(seq), item: { type: "user_message", text } };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function captureError(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}
