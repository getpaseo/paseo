import { describe, expect, it } from "vitest";

import { BoundedAgentTimelineHotStore } from "./bounded-agent-timeline-hot-store.js";

describe("BoundedAgentTimelineHotStore", () => {
  it("bounds retained rows and UTF-8 bytes without shrinking the logical timeline window", () => {
    const store = new BoundedAgentTimelineHotStore({ maxRows: 2, maxBytes: 10_000 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });

    store.append("agent-1", row(1, `one-é${"x".repeat(80)}`), { durable: true });
    store.append("agent-1", row(2, `two-é${"x".repeat(80)}`), { durable: true });
    store.append("agent-1", row(3, `three-é${"x".repeat(80)}`), { durable: true });

    expect(store.snapshot("agent-1")).toEqual({
      epoch: "epoch-1",
      logicalWindow: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      retainedWindow: { minSeq: 2, maxSeq: 3 },
      encodedBytes: expect.any(Number),
      rows: [row(2, `two-é${"x".repeat(80)}`), row(3, `three-é${"x".repeat(80)}`)],
    });
    expect(store.snapshot("agent-1").encodedBytes).toBeLessThanOrEqual(10_000);
  });

  it("uses encoded UTF-8 bytes for its independent byte bound", () => {
    const first = row(1, "😀".repeat(30));
    const second = row(2, "😀".repeat(30));
    const oneRowBytes = Buffer.byteLength(JSON.stringify(first), "utf8");
    const store = new BoundedAgentTimelineHotStore({
      maxRows: 10,
      maxBytes: oneRowBytes * 2 - 1,
    });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });

    store.append("agent-1", first, { durable: true });
    store.append("agent-1", second, { durable: true });

    expect(store.snapshot("agent-1").rows).toEqual([second]);
    expect(store.snapshot("agent-1").encodedBytes).toBe(oneRowBytes);
  });

  it("keeps the newest row even when that row alone exceeds both bounds", () => {
    const oversized = row(1, "😀".repeat(100));
    const store = new BoundedAgentTimelineHotStore({ maxRows: 1, maxBytes: 1 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });

    store.append("agent-1", oversized, { durable: true });

    expect(store.snapshot("agent-1").rows).toEqual([oversized]);
    expect(store.snapshot("agent-1").encodedBytes).toBeGreaterThan(1);
  });

  it("pins unacknowledged and mutable rows until durability and completion precede eviction", () => {
    const store = new BoundedAgentTimelineHotStore({ maxRows: 1, maxBytes: 10_000 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });
    const pending = store.append("agent-1", row(1, "pending"));
    store.append("agent-1", row(2, "durable"), { durable: true });

    expect(store.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([1, 2]);
    store.acknowledgeDurable("agent-1", pending);
    expect(store.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([2]);

    store.append("agent-1", row(3, "incomplete"), { durable: true, mutable: true });
    store.append("agent-1", row(4, "later"), { durable: true });
    expect(store.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([3, 4]);
    const completed = store.update("agent-1", row(3, "complete"), { mutable: false });
    expect(store.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([3, 4]);
    store.acknowledgeDurable("agent-1", completed);
    expect(store.snapshot("agent-1").rows).toEqual([row(4, "later")]);
  });

  it("keeps pinned rows plus only a bounded newest eligible tail", () => {
    const store = new BoundedAgentTimelineHotStore({ maxRows: 3, maxBytes: 10_000 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });
    store.append("agent-1", row(1, "pinned"), { durable: true, mutable: true });
    for (let seq = 2; seq <= 6; seq += 1) {
      store.append("agent-1", row(seq, `eligible-${seq}`), { durable: true });
    }

    expect(store.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([1, 5, 6]);
  });

  it("sparsely evicts eligible rows around a pin to meet the encoded-byte bound", () => {
    const pinned = row(1, "pinned");
    const newest = row(6, "eligible");
    const maxBytes =
      Buffer.byteLength(JSON.stringify(pinned), "utf8") +
      Buffer.byteLength(JSON.stringify(newest), "utf8") * 2;
    const store = new BoundedAgentTimelineHotStore({ maxRows: 100, maxBytes });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });
    store.append("agent-1", pinned, { durable: true, mutable: true });
    for (let seq = 2; seq <= 6; seq += 1) {
      store.append("agent-1", row(seq, "eligible"), { durable: true });
    }

    expect(store.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([1, 5, 6]);
    expect(store.snapshot("agent-1").encodedBytes).toBeLessThanOrEqual(maxBytes);
  });

  it("requires an exact current revision before acknowledging an updated row", () => {
    const store = new BoundedAgentTimelineHotStore({ maxRows: 1, maxBytes: 10_000 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });
    const inserted = store.append("agent-1", row(1, "insert"));
    store.append("agent-1", row(2, "newest"), { durable: true });
    const updated = store.update("agent-1", row(1, "updated"));

    expect(store.acknowledgeDurable("agent-1", inserted)).toBe(false);
    expect(store.snapshot("agent-1").rows.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(store.acknowledgeDurable("agent-1", updated)).toBe(true);
    expect(store.snapshot("agent-1").rows).toEqual([row(2, "newest")]);
  });

  it("initializes the complete logical durable window even when no rows are hot", () => {
    const store = new BoundedAgentTimelineHotStore({ maxRows: 2, maxBytes: 1_000 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 10, maxSeq: 99, nextSeq: 100 },
    });

    expect(store.snapshot("agent-1")).toMatchObject({
      logicalWindow: { minSeq: 10, maxSeq: 99, nextSeq: 100 },
      retainedWindow: { minSeq: 0, maxSeq: 0 },
      rows: [],
    });
  });

  it("reports recent and pinned/pending retention, then releases agent lifecycle state", () => {
    const store = new BoundedAgentTimelineHotStore({ maxRows: 4, maxBytes: 10_000 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });
    store.append("agent-1", row(1, "recent"), { durable: true });
    store.append("agent-1", row(2, "pending"));
    store.append("agent-1", row(3, "mutable"), { durable: true, mutable: true });

    expect(store.metrics("agent-1")).toMatchObject({
      retainedRows: 3,
      recentRows: 1,
      pinnedRows: 2,
      pendingRows: 1,
    });
    expect(store.metrics("agent-1").retainedBytes).toBe(
      store.metrics("agent-1").recentBytes + store.metrics("agent-1").pinnedBytes,
    );
    store.deleteAgent("agent-1");
    expect(store.has("agent-1")).toBe(false);

    store.initialize("agent-2", {
      epoch: "epoch-2",
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    });
    store.clear();
    expect(store.has("agent-2")).toBe(false);
  });

  it("rejects a non-contiguous initialized logical window", () => {
    const store = new BoundedAgentTimelineHotStore({ maxRows: 2, maxBytes: 1_000 });

    expect(() =>
      store.initialize("agent-1", {
        epoch: "epoch-1",
        window: { minSeq: 10, maxSeq: 99, nextSeq: 101 },
      }),
    ).toThrow("Invalid logical timeline window");
  });
});

function row(seq: number, text: string) {
  return {
    seq,
    timestamp: "2026-08-31T12:00:00.000Z",
    item: { type: "user_message" as const, text },
  };
}
