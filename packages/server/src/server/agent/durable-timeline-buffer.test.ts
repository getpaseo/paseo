import { describe, expect, test } from "vitest";

import { DurableTimelineBuffer } from "./durable-timeline-buffer.js";
import type {
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineSnapshot,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const row = (seq: number): AgentTimelineRow => ({
  seq,
  timestamp: "2026-01-01T00:00:00.000Z",
  item: { type: "assistant_message", text: String(seq) },
});

class RecordingStore implements AgentTimelineStore {
  readonly batches: AgentTimelineRow[][] = [];
  failuresRemaining = 0;

  async appendCommitted(): Promise<AgentTimelineRow> {
    throw new Error("not used");
  }
  async fetchCommitted(): Promise<AgentTimelineFetchResult> {
    throw new Error("not used");
  }
  async getLatestCommittedSeq(): Promise<number> {
    return 0;
  }
  async getCommittedRows(): Promise<AgentTimelineRow[]> {
    return [];
  }
  async getCommittedSnapshot(): Promise<AgentTimelineSnapshot> {
    return { rows: [], historyComplete: false };
  }
  async getLastItem(): Promise<AgentTimelineItem | null> {
    return null;
  }
  async getLastAssistantMessage(): Promise<string | null> {
    return null;
  }
  async deleteAgent(): Promise<void> {}
  async bulkInsert(_agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    this.batches.push([...rows]);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("disk full");
    }
  }
  async replaceCommittedSnapshot(): Promise<void> {}
  async updateCommittedRow(): Promise<void> {}
}

class ControlledTimers {
  readonly delays: number[] = [];
  private readonly callbacks = new Map<number, () => void>();
  private nextId = 1;

  setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.delays.push(delayMs);
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    this.callbacks.delete(timer as unknown as number);
  };

  async runNext(): Promise<void> {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error("Expected a scheduled timer");
    this.callbacks.delete(next[0]);
    next[1]();
    await Promise.resolve();
    await Promise.resolve();
  }

  get size(): number {
    return this.callbacks.size;
  }
}

const timers = {
  setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: () => undefined,
};

describe("DurableTimelineBuffer", () => {
  test("retries a failed prefix with later rows without a sequence hole", async () => {
    const store = new RecordingStore();
    store.failuresRemaining = 1;
    const buffer = new DurableTimelineBuffer(store, 25, timers, () => undefined);

    buffer.enqueue("agent", row(1));
    await expect(buffer.flush("agent")).rejects.toThrow("disk full");
    buffer.enqueue("agent", row(2));
    await buffer.flush("agent");

    const batchSequences = store.batches.map(batchSequencesFor);
    expect(batchSequences).toEqual([[1], [1, 2]]);
  });

  test("coalesces a burst into one bounded atomic write and flush drains it", async () => {
    const store = new RecordingStore();
    const buffer = new DurableTimelineBuffer(store, 25, timers, () => undefined);

    for (let seq = 1; seq <= 50; seq += 1) buffer.enqueue("agent", row(seq));
    await buffer.flushAll();

    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]?.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
  });

  test("discard drops a pending batch so a later global flush cannot resurrect it", async () => {
    const store = new RecordingStore();
    const buffer = new DurableTimelineBuffer(store, 25, timers, () => undefined);

    buffer.enqueue("agent", row(1));
    await buffer.discard("agent");
    await buffer.flushAll();
    buffer.enqueue("agent", row(1));
    await buffer.flushAll();

    expect(store.batches).toEqual([[row(1)]]);
  });

  test("retries a final failed batch without another enqueue", async () => {
    const store = new RecordingStore();
    store.failuresRemaining = 1;
    const controlledTimers = new ControlledTimers();
    const errors: unknown[] = [];
    const buffer = new DurableTimelineBuffer(
      store,
      25,
      controlledTimers,
      (_agentId, error) => errors.push(error),
      { baseDelayMs: 10, maxDelayMs: 40 },
    );

    buffer.enqueue("agent", row(1));
    await controlledTimers.runNext();
    expect(store.batches.map(batchSequencesFor)).toEqual([[1]]);
    expect(errors).toHaveLength(1);
    expect(controlledTimers.delays).toEqual([25, 10]);

    await controlledTimers.runNext();
    expect(store.batches.map(batchSequencesFor)).toEqual([[1], [1]]);
    expect(controlledTimers.size).toBe(0);
  });

  test("grows retry delays to a deterministic cap", async () => {
    const store = new RecordingStore();
    store.failuresRemaining = 4;
    const controlledTimers = new ControlledTimers();
    const buffer = new DurableTimelineBuffer(store, 25, controlledTimers, () => undefined, {
      baseDelayMs: 10,
      maxDelayMs: 40,
    });

    buffer.enqueue("agent", row(1));
    await controlledTimers.runNext();
    await controlledTimers.runNext();
    await controlledTimers.runNext();
    await controlledTimers.runNext();
    await controlledTimers.runNext();

    expect(controlledTimers.delays).toEqual([25, 10, 20, 40, 40]);
    expect(store.batches).toHaveLength(5);
  });

  test("joins a later enqueue behind the retained failed prefix", async () => {
    const store = new RecordingStore();
    store.failuresRemaining = 1;
    const controlledTimers = new ControlledTimers();
    const buffer = new DurableTimelineBuffer(store, 25, controlledTimers, () => undefined, {
      baseDelayMs: 10,
    });

    buffer.enqueue("agent", row(1));
    await controlledTimers.runNext();
    buffer.enqueue("agent", row(2));
    await controlledTimers.runNext();

    expect(store.batches.map(batchSequencesFor)).toEqual([[1], [1, 2]]);
  });

  test("discard cancels a retry after failure", async () => {
    const store = new RecordingStore();
    store.failuresRemaining = 1;
    const controlledTimers = new ControlledTimers();
    const buffer = new DurableTimelineBuffer(store, 25, controlledTimers, () => undefined, {
      baseDelayMs: 10,
    });

    buffer.enqueue("agent", row(1));
    await controlledTimers.runNext();
    await buffer.discard("agent");

    expect(controlledTimers.size).toBe(0);
    expect(store.batches.map(batchSequencesFor)).toEqual([[1]]);
  });

  test("manual flush rejects while retaining an autonomous retry", async () => {
    const store = new RecordingStore();
    store.failuresRemaining = 1;
    const controlledTimers = new ControlledTimers();
    const buffer = new DurableTimelineBuffer(store, 25, controlledTimers, () => undefined, {
      baseDelayMs: 10,
    });

    buffer.enqueue("agent", row(1));
    await expect(buffer.flush("agent")).rejects.toThrow("disk full");
    expect(controlledTimers.delays).toEqual([25, 10]);

    await controlledTimers.runNext();
    expect(store.batches.map(batchSequencesFor)).toEqual([[1], [1]]);
  });
});

function batchSequencesFor(batch: AgentTimelineRow[]): number[] {
  return batch.map((entry) => entry.seq);
}
