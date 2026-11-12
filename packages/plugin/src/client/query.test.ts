import { describe, expect, it } from "vitest";
import { createCollectionQuery, type GroupKey } from "./query.js";

const first = Object.freeze({ key: "a" });
const second = Object.freeze({ key: "b" });
const work: GroupKey = "work";
const snapshots = [
  { ref: first, hostId: "one", title: "A", status: "running", labels: [work, work] },
  { ref: second, hostId: "two", title: "B", status: "idle", labels: ["home"] },
];

describe("collection query structural sharing", () => {
  it("preserves collection identity when a row changes without changing membership", () => {
    const project = createCollectionQuery<(typeof snapshots)[number]>();
    const before = project(snapshots);
    const after = project([{ ...snapshots[0]!, status: "waiting" }, snapshots[1]!]);
    expect(after).toBe(before);
    expect(after).toEqual([first, second]);
  });

  it("shares unaffected groups and deduplicates membership", () => {
    const project = createCollectionQuery<(typeof snapshots)[number]>();
    const query = { groupBy: (item: (typeof snapshots)[number]) => item.labels };
    const before = project(snapshots, query);
    const after = project([{ ...snapshots[0]!, labels: ["new"] }, snapshots[1]!], query);
    expect(after[1]).toBe(before[1]);
    expect(before[0]).toEqual({ key: "work", title: null, color: null, items: [first] });
    expect(after[0]).toEqual({ key: "new", title: null, color: null, items: [first] });
    expect(project([{ ...snapshots[0]!, labels: ["new"] }, snapshots[1]!], query)).toBe(after);
  });

  it("filters hosts and predicates before sorting", () => {
    const project = createCollectionQuery<(typeof snapshots)[number]>();
    expect(project(snapshots, { hosts: ["two"] })).toEqual([second]);
    expect(project(snapshots, { where: (item) => item.status === "running" })).toEqual([first]);
    expect(project(snapshots, { orderBy: ["title", "desc"] })).toEqual([second, first]);
    expect(project(snapshots, { orderBy: (a, b) => a.title.localeCompare(b.title) })).toEqual([
      first,
      second,
    ]);
  });

  it("keeps nulls last in either direction and metadata from the first group", () => {
    const project = createCollectionQuery<{
      ref: typeof first;
      hostId: string;
      title: string | null;
    }>();
    const items = [
      { ref: first, hostId: "one", title: null },
      { ref: second, hostId: "one", title: "Z" },
    ];
    expect(project(items, { orderBy: ["title", "desc"] })).toEqual([second, first]);
    expect(
      project(items, { groupBy: (item) => ({ key: "all", title: item.title ?? "First" }) }),
    ).toEqual([{ key: "all", title: "First", color: null, items: [first, second] }]);
  });
});
