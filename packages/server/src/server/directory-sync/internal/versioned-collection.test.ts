import { describe, expect, test } from "vitest";
import { VersionedCollection } from "./versioned-collection.js";

describe("VersionedCollection", () => {
  test("returns only each entity's latest visible snapshot after a sequence", () => {
    const collection = new VersionedCollection<{ id: string; title: string }>({
      getId: (value) => value.id,
    });
    collection.replace({ id: "one", title: "first" });
    const cursor = collection.headSeq;
    collection.replace({ id: "one", title: "second" });
    collection.replace({ id: "one", title: "latest" });
    collection.replace({ id: "two", title: "other" });

    expect(collection.readAfter(cursor)).toEqual({
      mode: "changes",
      headSeq: 4,
      values: [
        { seq: 3, value: { id: "one", title: "latest" } },
        { seq: 4, value: { id: "two", title: "other" } },
      ],
      removals: [],
    });
  });

  test("does not advance for an unchanged projection or repeated removal", () => {
    const collection = new VersionedCollection<{ id: string; title: string }>({
      getId: (value) => value.id,
    });
    expect(collection.replace({ id: "one", title: "same" })?.seq).toBe(1);
    expect(collection.replace({ id: "one", title: "same" })).toBeNull();
    expect(collection.remove("one")?.seq).toBe(2);
    expect(collection.remove("one")).toBeNull();
    expect(collection.headSeq).toBe(2);
  });

  test("returns tombstones and lets a later value replace them", () => {
    const collection = new VersionedCollection<{ id: string; title: string }>({
      getId: (value) => value.id,
    });
    collection.replace({ id: "one", title: "before" });
    collection.remove("one");
    expect(collection.readAfter(1)).toEqual({
      mode: "changes",
      headSeq: 2,
      values: [],
      removals: [{ id: "one", seq: 2 }],
    });

    collection.replace({ id: "one", title: "after" });
    expect(collection.readAfter(2)).toEqual({
      mode: "changes",
      headSeq: 3,
      values: [{ seq: 3, value: { id: "one", title: "after" } }],
      removals: [],
    });
  });

  test("falls back to a latest snapshot when a required tombstone expired", () => {
    const collection = new VersionedCollection<{ id: string }>({
      getId: (value) => value.id,
      maxTombstones: 1,
    });
    collection.replace({ id: "one" });
    collection.replace({ id: "two" });
    collection.remove("one");
    collection.remove("two");

    expect(collection.readAfter(2)).toEqual({
      mode: "snapshot",
      reason: "cursor_expired",
      headSeq: 4,
      values: [],
      removals: [],
    });
  });
});
