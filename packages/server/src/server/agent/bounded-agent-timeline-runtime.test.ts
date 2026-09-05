import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { BoundedAgentTimelineRuntime } from "./bounded-agent-timeline-runtime.js";
import { SegmentedFileAgentTimelineStore } from "./segmented-file-agent-timeline-store.js";
import type { TimelineDurableSink } from "./ordered-agent-timeline-durable-buffer.js";
import { TimelineDurableBufferBackpressureError } from "./ordered-agent-timeline-durable-buffer.js";
import { projectTimelineRows } from "./timeline-projection.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("BoundedAgentTimelineRuntime", () => {
  it("rejects a durable row limit above the hot byte ceiling", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-row-ceiling-"));
    temporaryDirectories.push(directory);

    expect(
      () =>
        new BoundedAgentTimelineRuntime(new SegmentedFileAgentTimelineStore(directory), {
          hot: { maxRows: 1, maxBytes: 100 },
          buffer: { maxBatchBytes: 200, maxPendingBytes: 200, maxRowBytes: 101 },
        }),
    ).toThrow("maxRowBytes must not exceed the hot timeline maxBytes");
  });

  it("derives the default row limit from every configured byte ceiling", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-row-default-"));
    temporaryDirectories.push(directory);

    expect(
      () =>
        new BoundedAgentTimelineRuntime(new SegmentedFileAgentTimelineStore(directory), {
          hot: { maxRows: 1, maxBytes: 300 },
          buffer: { maxBatchBytes: 200, maxPendingBytes: 100 },
        }),
    ).not.toThrow();
  });

  it("pages a durable prefix while exposing a pending hot tail exactly once", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory, { maxRowsPerSegment: 1 });
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    let holdFirstWrite = true;
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        if (holdFirstWrite) {
          holdFirstWrite = false;
          writeStarted.resolve();
          await releaseWrite.promise;
        }
        await durable.bulkInsert(agentId, rows);
      },
      updateCommittedRow: async (agentId, row) => {
        await durable.updateCommittedRow(agentId, row);
      },
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 2, maxBytes: 10_000 },
      buffer: { maxPendingRows: 3, maxPendingBytes: 10_000, maxBatchRows: 2 },
    });
    await runtime.initialize("agent-1");

    runtime.append("agent-1", assistantRow(1));
    runtime.append("agent-1", assistantRow(2));
    runtime.append("agent-1", assistantRow(3));
    await writeStarted.promise;

    await expect(runtime.fetch("agent-1", { direction: "tail", limit: 3 })).resolves.toMatchObject({
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      rows: [assistantRow(1), assistantRow(2), assistantRow(3)],
    });
    expect(runtime.metrics("agent-1").hot.pendingRows).toBe(3);

    releaseWrite.resolve();
    await runtime.flush("agent-1");
    expect(runtime.metrics("agent-1").hot.retainedRows).toBeLessThanOrEqual(2);

    const tail = await runtime.fetch("agent-1", { direction: "tail", limit: 2 });
    expect(tail.rows).toEqual([assistantRow(2), assistantRow(3)]);
    const older = await runtime.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: tail.epoch, seq: 2 },
      limit: 1,
    });
    expect(older.rows).toEqual([assistantRow(1)]);
  });

  it("retries a fetch when a committed row is evicted from hot after the durable snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-fetch-race-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory, { maxRowsPerSegment: 1 });
    const rowTwoWriteStarted = deferred<void>();
    const releaseRowTwoWrite = deferred<void>();
    const rowThreeWriteStarted = deferred<void>();
    const releaseRowThreeWrite = deferred<void>();
    const durableFetchCaptured = deferred<void>();
    const releaseDurableFetch = deferred<void>();
    let write = 0;
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        write += 1;
        if (write === 1) {
          rowTwoWriteStarted.resolve();
          await releaseRowTwoWrite.promise;
        } else if (write === 2) {
          rowThreeWriteStarted.resolve();
          await releaseRowThreeWrite.promise;
        }
        await durable.bulkInsert(agentId, rows);
      },
      updateCommittedRow: async (agentId, row) => {
        await durable.updateCommittedRow(agentId, row);
      },
    };
    await durable.bulkInsert("agent-1", [assistantRow(1)]);
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 1, maxBytes: 10_000 },
      buffer: { maxPendingRows: 2, maxPendingBytes: 10_000, maxBatchRows: 1 },
    });
    await runtime.initialize("agent-1");

    runtime.append("agent-1", assistantRow(2));
    runtime.append("agent-1", assistantRow(3));
    await rowTwoWriteStarted.promise;

    const originalFetch = durable.fetchCommitted.bind(durable);
    let intercept = true;
    durable.fetchCommitted = async (...args) => {
      const result = await originalFetch(...args);
      if (intercept) {
        intercept = false;
        durableFetchCaptured.resolve();
        await releaseDurableFetch.promise;
      }
      return result;
    };
    const fetching = runtime.fetch("agent-1", { direction: "tail", limit: 3 });
    await durableFetchCaptured.promise;

    releaseRowTwoWrite.resolve();
    await rowThreeWriteStarted.promise;
    expect(runtime.getHotRows("agent-1").map(({ seq }) => seq)).toEqual([3]);
    releaseDurableFetch.resolve();

    await expect(fetching).resolves.toMatchObject({
      rows: [assistantRow(1), assistantRow(2), assistantRow(3)],
    });
    releaseRowThreeWrite.resolve();
    await runtime.flush("agent-1");
  });

  it("rejects an in-flight read when its runtime generation is replaced", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-read-generation-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    await durable.bulkInsert("agent-1", [assistantRow(1, "old")]);
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      hot: { maxRows: 1, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");
    const originalFetch = durable.fetchCommitted.bind(durable);
    const oldReadCaptured = deferred<void>();
    const releaseOldRead = deferred<void>();
    let hold = true;
    durable.fetchCommitted = async (...args) => {
      const result = await originalFetch(...args);
      if (hold) {
        hold = false;
        oldReadCaptured.resolve();
        await releaseOldRead.promise;
      }
      return result;
    };

    const oldRead = runtime.fetch("agent-1", { direction: "tail", limit: 1 });
    await oldReadCaptured.promise;
    await runtime.discardAndDelete("agent-1");
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1, "new"));
    await runtime.flush("agent-1");
    releaseOldRead.resolve();

    await expect(oldRead).rejects.toThrow("Timeline runtime generation changed");
    await expect(runtime.fetch("agent-1", { direction: "tail", limit: 1 })).resolves.toMatchObject({
      rows: [assistantRow(1, "new")],
    });
  });

  it("does not resume a backpressured writer into a replacement generation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-write-generation-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: {
        bulkInsert: async (agentId, rows) => {
          writeStarted.resolve();
          await releaseWrite.promise;
          await durable.bulkInsert(agentId, rows);
        },
        updateCommittedRow: async (agentId, row) => await durable.updateCommittedRow(agentId, row),
      },
      hot: { maxRows: 1, maxBytes: 10_000 },
      buffer: { maxPendingRows: 1, maxPendingBytes: 10_000 },
    });
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1, "old"));
    await writeStarted.promise;
    const blocked = runtime.appendWhenWritable("agent-1", assistantRow(2, "must not replay"));
    const blockedResult = blocked.then(
      () => null,
      (error: unknown) => error,
    );
    const deleting = runtime.discardAndDelete("agent-1");
    releaseWrite.resolve();
    await deleting;
    await runtime.initialize("agent-1");

    await expect(blockedResult).resolves.toMatchObject({
      message: expect.stringMatching(/generation changed|not accepting writes/),
    });
    await expect(runtime.fetch("agent-1", { direction: "tail", limit: 10 })).resolves.toMatchObject(
      {
        rows: [],
      },
    );
  });

  it("retries a fetch when an updated overlap commits and is evicted after the durable snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-update-race-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory, { maxRowsPerSegment: 1 });
    await durable.bulkInsert("agent-1", [assistantRow(1, "old")]);
    const updateStarted = deferred<void>();
    const releaseUpdate = deferred<void>();
    const rowTwoWriteStarted = deferred<void>();
    const releaseRowTwoWrite = deferred<void>();
    const durableFetchCaptured = deferred<void>();
    const releaseDurableFetch = deferred<void>();
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        rowTwoWriteStarted.resolve();
        await releaseRowTwoWrite.promise;
        await durable.bulkInsert(agentId, rows);
      },
      updateCommittedRow: async (agentId, row) => {
        updateStarted.resolve();
        await releaseUpdate.promise;
        await durable.updateCommittedRow(agentId, row);
      },
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 1, maxBytes: 10_000 },
      buffer: { maxPendingRows: 2, maxPendingBytes: 10_000, maxBatchRows: 1 },
    });
    await runtime.initialize("agent-1");
    runtime.update("agent-1", assistantRow(1, "new"));
    runtime.append("agent-1", assistantRow(2));
    await updateStarted.promise;

    const originalFetch = durable.fetchCommitted.bind(durable);
    let intercept = true;
    durable.fetchCommitted = async (...args) => {
      const result = await originalFetch(...args);
      if (intercept) {
        intercept = false;
        durableFetchCaptured.resolve();
        await releaseDurableFetch.promise;
      }
      return result;
    };
    const fetching = runtime.fetch("agent-1", { direction: "tail", limit: 2 });
    await durableFetchCaptured.promise;

    releaseUpdate.resolve();
    await rowTwoWriteStarted.promise;
    expect(runtime.getHotRows("agent-1").map(({ seq }) => seq)).toEqual([2]);
    releaseDurableFetch.resolve();

    await expect(fetching).resolves.toMatchObject({
      rows: [assistantRow(1, "new"), assistantRow(2)],
    });
    releaseRowTwoWrite.resolve();
    await runtime.flush("agent-1");
  });

  it("serializes a backpressured retry without reordering timeline sequences", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-order-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const writes: number[][] = [];
    let holdFirstWrite = true;
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        writes.push(rows.map(({ seq }) => seq));
        if (holdFirstWrite) {
          holdFirstWrite = false;
          writeStarted.resolve();
          await releaseWrite.promise;
        }
        await durable.bulkInsert(agentId, rows);
      },
      updateCommittedRow: async (agentId, row) => {
        await durable.updateCommittedRow(agentId, row);
      },
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 2, maxBytes: 10_000 },
      buffer: { maxPendingRows: 1, maxPendingBytes: 10_000, maxBatchRows: 1 },
    });
    await runtime.initialize("agent-1");

    runtime.append("agent-1", assistantRow(1));
    let backpressure: TimelineDurableBufferBackpressureError | undefined;
    try {
      runtime.append("agent-1", assistantRow(2));
    } catch (error) {
      expect(error).toBeInstanceOf(TimelineDurableBufferBackpressureError);
      backpressure = error as TimelineDurableBufferBackpressureError;
    }
    await writeStarted.promise;
    expect(runtime.metrics("agent-1").buffer).toMatchObject({
      pendingRows: 1,
      writableSignals: 1,
    });

    releaseWrite.resolve();
    await backpressure!.whenWritable;
    runtime.append("agent-1", assistantRow(2));
    await runtime.flush("agent-1");
    runtime.append("agent-1", assistantRow(3));
    await runtime.flush("agent-1");
    expect(writes).toEqual([[1], [2], [3]]);
  });

  it("rejects a burst before retaining rows beyond the durable buffer admission bound", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-burst-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        await durable.bulkInsert(agentId, rows);
      },
      updateCommittedRow: async (agentId, row) => {
        await durable.updateCommittedRow(agentId, row);
      },
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 2, maxBytes: 1_000 },
      buffer: { maxPendingRows: 2, maxPendingBytes: 1_000, maxBatchRows: 1 },
    });
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1, "x".repeat(200)));
    runtime.append("agent-1", assistantRow(2, "x".repeat(200)));
    await writeStarted.promise;

    let backpressure: TimelineDurableBufferBackpressureError | undefined;
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      try {
        runtime.append("agent-1", assistantRow(3, "x".repeat(200)));
      } catch (error) {
        expect(error).toBeInstanceOf(TimelineDurableBufferBackpressureError);
        backpressure = error as TimelineDurableBufferBackpressureError;
      }
    }
    expect(runtime.metrics("agent-1")).toMatchObject({
      hot: { retainedRows: 2, pendingRows: 2 },
      buffer: { pendingRows: 2, writableSignals: 1 },
    });

    releaseWrite.resolve();
    await backpressure!.whenWritable;
    runtime.append("agent-1", assistantRow(3, "x".repeat(200)));
    await runtime.flush("agent-1");
    await expect(durable.getCommittedRows("agent-1")).resolves.toEqual([
      assistantRow(1, "x".repeat(200)),
      assistantRow(2, "x".repeat(200)),
      assistantRow(3, "x".repeat(200)),
    ]);
  });

  it("keeps a failed durable row pinned and exposes the persistence failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-failure-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const failure = new Error("durable cache unavailable");
    const sink: TimelineDurableSink = {
      bulkInsert: async () => {
        throw failure;
      },
      updateCommittedRow: async () => {
        throw failure;
      },
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 1, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");

    runtime.append("agent-1", assistantRow(1));

    await expect(runtime.flush("agent-1")).rejects.toBe(failure);
    expect(runtime.metrics("agent-1")).toMatchObject({
      hot: { retainedRows: 1, pinnedRows: 1, pendingRows: 1 },
      durabilityError: failure,
    });
  });

  it("rejects flush promptly when a failed durable prefix has an admitted suffix", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-prefix-failure-"));
    temporaryDirectories.push(directory);
    const failure = new Error("durable prefix failed");
    const runtime = new BoundedAgentTimelineRuntime(
      new SegmentedFileAgentTimelineStore(directory),
      {
        durableSink: {
          bulkInsert: async () => {
            throw failure;
          },
          updateCommittedRow: async () => {
            throw failure;
          },
        },
        hot: { maxRows: 2, maxBytes: 10_000 },
        buffer: { maxPendingRows: 2, maxPendingBytes: 10_000, maxBatchRows: 1 },
      },
    );
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1));
    runtime.append("agent-1", assistantRow(2));

    await expect(
      Promise.race([
        runtime.flush("agent-1"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("flush timed out")), 100)),
      ]),
    ).rejects.toBe(failure);
  });

  it("fences an active writer before deleting hot and durable agent state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-delete-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        await durable.bulkInsert(agentId, rows);
      },
      updateCommittedRow: async (agentId, row) => {
        await durable.updateCommittedRow(agentId, row);
      },
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 2, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1));
    await writeStarted.promise;

    let deleted = false;
    const deletion = runtime.discardAndDelete("agent-1").then(() => {
      deleted = true;
      return undefined;
    });
    await Promise.resolve();
    expect(deleted).toBe(false);
    releaseWrite.resolve();
    await deletion;

    expect(runtime.has("agent-1")).toBe(false);
    await expect(durable.getCommittedRows("agent-1")).resolves.toEqual([]);
  });

  it("drains and releases resident state without deleting the durable cache", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-release-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        await durable.bulkInsert(agentId, rows);
      },
      updateCommittedRow: async (agentId, row) => {
        await durable.updateCommittedRow(agentId, row);
      },
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 2, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1));
    await writeStarted.promise;

    let released = false;
    const release = runtime.release("agent-1").then(() => {
      released = true;
      return undefined;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(() => runtime.append("agent-1", assistantRow(2))).toThrow(
      "Timeline runtime is not accepting writes",
    );
    releaseWrite.resolve();
    await release;

    expect(runtime.has("agent-1")).toBe(false);
    await expect(durable.getCommittedRows("agent-1")).resolves.toEqual([assistantRow(1)]);

    await runtime.initialize("agent-1");
    expect(runtime.getHotItems("agent-1")).toEqual([{ type: "assistant_message", text: "row-1" }]);
    expect(runtime.metrics("agent-1").hot).toMatchObject({
      retainedRows: 1,
      recentRows: 1,
      pendingRows: 0,
    });
  });

  it("invalidates the disposable durable cache when release observes a failed write", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-failed-release-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const failure = new Error("second cache write failed");
    let writes = 0;
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: {
        bulkInsert: async (agentId, rows) => {
          writes += 1;
          if (writes > 1) throw failure;
          await durable.bulkInsert(agentId, rows);
        },
        updateCommittedRow: async (agentId, row) => await durable.updateCommittedRow(agentId, row),
      },
      hot: { maxRows: 1, maxBytes: 10_000 },
      buffer: { maxBatchRows: 1 },
    });
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1));
    await runtime.flush("agent-1");
    runtime.append("agent-1", assistantRow(2));
    await expect(runtime.flush("agent-1")).rejects.toBe(failure);

    await expect(runtime.release("agent-1")).rejects.toBe(failure);
    await expect(durable.getCommittedRows("agent-1")).resolves.toEqual([]);
  });

  it("allows discard-and-delete to retry after durable deletion fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-delete-retry-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const originalDelete = durable.deleteAgent.bind(durable);
    const failure = new Error("delete failed");
    let failDelete = true;
    durable.deleteAgent = async (agentId) => {
      if (failDelete) throw failure;
      await originalDelete(agentId);
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      hot: { maxRows: 1, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");

    await expect(runtime.discardAndDelete("agent-1")).rejects.toBe(failure);
    expect(runtime.aggregateMetrics().failedAgents).toBe(1);
    failDelete = false;
    await expect(runtime.discardAndDelete("agent-1")).resolves.toBeUndefined();
    expect(runtime.has("agent-1")).toBe(false);
  });

  it("keeps a failed cache invalidation fenced until deletion can be retried", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-release-retry-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const originalDelete = durable.deleteAgent.bind(durable);
    const writeFailure = new Error("cache write failed");
    const deleteFailure = new Error("cache delete failed");
    let failDelete = true;
    durable.deleteAgent = async (agentId) => {
      if (failDelete) throw deleteFailure;
      await originalDelete(agentId);
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: {
        bulkInsert: async () => {
          throw writeFailure;
        },
        updateCommittedRow: async () => undefined,
      },
      hot: { maxRows: 1, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1));
    await expect(runtime.release("agent-1")).rejects.toBeInstanceOf(AggregateError);

    await expect(runtime.initialize("agent-1")).rejects.toThrow(
      "Timeline runtime cache deletion must be retried",
    );
    expect(runtime.has("agent-1")).toBe(false);

    failDelete = false;
    await runtime.discardAndDelete("agent-1");
    await runtime.initialize("agent-1");
    expect(runtime.getHotRows("agent-1")).toEqual([]);
  });

  it("single-flights concurrent initialization and does not retain release tombstones", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-init-fence-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const originalFetch = durable.fetchCommitted.bind(durable);
    const fetchStarted = deferred<void>();
    const releaseFetch = deferred<void>();
    let fetches = 0;
    durable.fetchCommitted = async (...args) => {
      fetches += 1;
      fetchStarted.resolve();
      await releaseFetch.promise;
      return await originalFetch(...args);
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      hot: { maxRows: 1, maxBytes: 10_000 },
    });
    const first = runtime.initialize("agent-1");
    await fetchStarted.promise;
    const second = runtime.initialize("agent-1");
    releaseFetch.resolve();
    await Promise.all([first, second]);
    expect(fetches).toBe(1);
    await runtime.release("agent-1");
    expect((runtime as unknown as { lifecycle: Map<string, unknown> }).lifecycle.size).toBe(0);
  });

  it("projects adjacent assistant rows across the durable and hot overlap boundary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-projection-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory, { maxRowsPerSegment: 1 });
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      hot: { maxRows: 1, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1, "first "));
    runtime.append("agent-1", assistantRow(2, "second"));
    await runtime.flush("agent-1");

    const timeline = await runtime.fetch("agent-1", { direction: "tail", limit: 2 });
    expect(runtime.metrics("agent-1").hot.retainedRows).toBe(1);
    expect(timeline.rows.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(projectTimelineRows({ rows: timeline.rows, mode: "projected" })).toMatchObject([
      {
        seqStart: 1,
        seqEnd: 2,
        item: { type: "assistant_message", text: "first second" },
      },
    ]);
    await expect(runtime.getLastAssistantMessage("agent-1")).resolves.toBe("first second");
    await expect(runtime.getLastItem("agent-1")).resolves.toEqual({
      type: "assistant_message",
      text: "second",
    });
  });

  it("preserves store navigation flags for empty pages beyond either edge", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-empty-pages-"));
    temporaryDirectories.push(directory);
    const runtime = new BoundedAgentTimelineRuntime(
      new SegmentedFileAgentTimelineStore(directory),
      { hot: { maxRows: 1, maxBytes: 10_000 } },
    );
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1));
    runtime.append("agent-1", assistantRow(2));
    await runtime.flush("agent-1");
    const epoch = runtime.getEpoch("agent-1");

    await expect(
      runtime.fetch("agent-1", {
        direction: "after",
        cursor: { epoch, seq: 2 },
        limit: 1,
      }),
    ).resolves.toMatchObject({ rows: [], hasOlder: true, hasNewer: false });
    await expect(
      runtime.fetch("agent-1", {
        direction: "before",
        cursor: { epoch, seq: 1 },
        limit: 1,
      }),
    ).resolves.toMatchObject({ rows: [], hasOlder: false, hasNewer: true });
  });

  it("prefers an unacknowledged hot update at the durable maximum sequence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-hot-update-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const updateStarted = deferred<void>();
    const releaseUpdate = deferred<void>();
    const sink: TimelineDurableSink = {
      bulkInsert: async (agentId, rows) => {
        await durable.bulkInsert(agentId, rows);
      },
      updateCommittedRow: async (agentId, row) => {
        updateStarted.resolve();
        await releaseUpdate.promise;
        await durable.updateCommittedRow(agentId, row);
      },
    };
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      durableSink: sink,
      hot: { maxRows: 1, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");
    runtime.append("agent-1", assistantRow(1, "old"));
    await runtime.flush("agent-1");
    runtime.update("agent-1", assistantRow(1, "new"));
    await updateStarted.promise;

    await expect(runtime.getLastItem("agent-1")).resolves.toEqual({
      type: "assistant_message",
      text: "new",
    });
    await expect(runtime.getLastAssistantMessage("agent-1")).resolves.toBe("new");

    releaseUpdate.resolve();
    await runtime.flush("agent-1");
  });

  it("pins a mutable submitted row through eviction pressure until enrichment is durable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-mutable-"));
    temporaryDirectories.push(directory);
    const durable = new SegmentedFileAgentTimelineStore(directory);
    const runtime = new BoundedAgentTimelineRuntime(durable, {
      hot: { maxRows: 1, maxBytes: 10_000 },
    });
    await runtime.initialize("agent-1");
    const submitted: AgentTimelineRow = {
      seq: 1,
      timestamp: "2026-08-31T12:00:00.000Z",
      item: { type: "user_message", text: "prompt", clientMessageId: "client-1" },
    };
    runtime.append("agent-1", submitted, { mutable: true });
    await runtime.flush("agent-1");
    runtime.append("agent-1", assistantRow(2));
    await runtime.flush("agent-1");
    expect(runtime.getHotRows("agent-1").map(({ seq }) => seq)).toEqual([1, 2]);

    runtime.update(
      "agent-1",
      { ...submitted, providerMessageId: "provider-1" },
      { mutable: false },
    );
    await runtime.flush("agent-1");
    const rows = await runtime.fetch("agent-1", { direction: "tail", limit: 2 });
    expect(rows.rows).toEqual([{ ...submitted, providerMessageId: "provider-1" }, assistantRow(2)]);
  });

  it("unpins submitted rows without provider echoes after their terminal boundary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-bounded-runtime-unpin-"));
    temporaryDirectories.push(directory);
    const runtime = new BoundedAgentTimelineRuntime(
      new SegmentedFileAgentTimelineStore(directory),
      { hot: { maxRows: 1, maxBytes: 10_000 } },
    );
    await runtime.initialize("agent-1");
    runtime.append(
      "agent-1",
      {
        seq: 1,
        timestamp: "2026-08-31T12:00:00.000Z",
        item: { type: "user_message", text: "failed prompt", clientMessageId: "client-1" },
      },
      { mutable: true },
    );
    await runtime.flush("agent-1");
    runtime.unpinMutableRows("agent-1", undefined);
    runtime.append("agent-1", assistantRow(2));
    await runtime.flush("agent-1");

    expect(runtime.getHotRows("agent-1").map(({ seq }) => seq)).toEqual([2]);
  });
});

function assistantRow(seq: number, text = `row-${seq}`): AgentTimelineRow {
  return {
    seq,
    timestamp: "2026-08-31T12:00:00.000Z",
    item: { type: "assistant_message", text },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve as (value?: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}
