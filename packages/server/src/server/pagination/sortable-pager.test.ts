import { describe, expect, it } from "vitest";
import { CursorError } from "./cursor.js";
import { SortablePager, type SortSpec } from "./sortable-pager.js";

const KEYS = ["created_at", "title", "updated_at"] as const;
type Key = (typeof KEYS)[number];

interface Row {
  id: string;
  created_at: number;
  title: string | null;
  updated_at: number;
}

const pager = new SortablePager<Row, Key>({
  validKeys: KEYS,
  defaultSort: [{ key: "updated_at", direction: "desc" }],
  label: "rows",
  getId: (row) => row.id,
  getSortValue: (row, key) => row[key],
});

const rowA: Row = { id: "a", created_at: 1, title: "alpha", updated_at: 30 };
const rowB: Row = { id: "b", created_at: 2, title: "bravo", updated_at: 20 };
const rowC: Row = { id: "c", created_at: 3, title: null, updated_at: 30 };

describe("SortablePager.normalizeSort", () => {
  it("falls back to default when sort is undefined", () => {
    expect(pager.normalizeSort(undefined)).toEqual([{ key: "updated_at", direction: "desc" }]);
  });

  it("falls back to default when sort is empty", () => {
    expect(pager.normalizeSort([])).toEqual([{ key: "updated_at", direction: "desc" }]);
  });

  it("dedupes by key, keeping the first occurrence", () => {
    const sort: SortSpec<Key>[] = [
      { key: "title", direction: "asc" },
      { key: "title", direction: "desc" },
      { key: "updated_at", direction: "desc" },
    ];
    expect(pager.normalizeSort(sort)).toEqual([
      { key: "title", direction: "asc" },
      { key: "updated_at", direction: "desc" },
    ]);
  });
});

describe("SortablePager.compare", () => {
  it("orders by primary sort direction", () => {
    const sort: SortSpec<Key>[] = [{ key: "updated_at", direction: "desc" }];
    expect(pager.compare(rowA, rowB, sort)).toBeLessThan(0);
    expect(pager.compare(rowB, rowA, sort)).toBeGreaterThan(0);
  });

  it("falls through to secondary sort when primary ties", () => {
    const sort: SortSpec<Key>[] = [
      { key: "updated_at", direction: "desc" },
      { key: "title", direction: "asc" },
    ];
    expect(pager.compare(rowA, rowC, sort)).toBeGreaterThan(0);
  });

  it("breaks final ties with id", () => {
    const sort: SortSpec<Key>[] = [{ key: "updated_at", direction: "desc" }];
    const twin: Row = { id: "z", created_at: 99, title: "alpha", updated_at: 30 };
    expect(pager.compare(rowA, twin, sort)).toBeLessThan(0);
  });

  it("treats null as less than any value", () => {
    const sort: SortSpec<Key>[] = [{ key: "title", direction: "asc" }];
    expect(pager.compare(rowC, rowA, sort)).toBeLessThan(0);
  });
});

describe("SortablePager cursor roundtrip", () => {
  const sort: SortSpec<Key>[] = [{ key: "updated_at", direction: "desc" }];

  it("encodes and decodes through the underlying codec", () => {
    const token = pager.encode(rowA, sort);
    const decoded = pager.decode(token, sort);
    expect(decoded.id).toBe("a");
    expect(decoded.values).toEqual({ updated_at: 30 });
  });

  it("translates codec errors with the configured label", () => {
    expect(() => pager.decode("@@@", sort)).toThrow(new CursorError("Invalid rows cursor"));
  });
});

describe("SortablePager.compareWithCursor", () => {
  const sort: SortSpec<Key>[] = [{ key: "updated_at", direction: "desc" }];

  it("places rows ahead of the cursor as positive", () => {
    const token = pager.encode(rowB, sort);
    const cursor = pager.decode(token, sort);
    expect(pager.compareWithCursor(rowA, cursor, sort)).toBeLessThan(0);
    expect(pager.compareWithCursor(rowC, cursor, sort)).toBeLessThan(0);
  });

  it("returns 0 only for the cursor's own row", () => {
    const token = pager.encode(rowA, sort);
    const cursor = pager.decode(token, sort);
    expect(pager.compareWithCursor(rowA, cursor, sort)).toBe(0);
  });
});
