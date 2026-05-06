import { describe, expect, it } from "vitest";
import { CursorError, type CursorSortEntry, decodeCursor, encodeCursor } from "./cursor.js";

const KEYS = ["created_at", "title", "updated_at"] as const;
type Key = (typeof KEYS)[number];

interface Entry {
  id: string;
  created_at: number;
  title: string;
  updated_at: number;
}

const sample: Entry = {
  id: "agent-1",
  created_at: 100,
  title: "first",
  updated_at: 200,
};

const sort: CursorSortEntry<Key>[] = [
  { key: "updated_at", direction: "desc" },
  { key: "title", direction: "asc" },
];

function encodeSample(entry: Entry = sample, sortSpec = sort): string {
  return encodeCursor(
    entry,
    sortSpec,
    (e) => e.id,
    (e, key) => e[key],
  );
}

describe("cursor-codec", () => {
  it("roundtrips through encode/decode", () => {
    const token = encodeSample();
    const decoded = decodeCursor(token, sort, KEYS, "things");

    expect(decoded.id).toBe("agent-1");
    expect(decoded.sort).toEqual(sort);
    expect(decoded.values).toEqual({ updated_at: 200, title: "first" });
  });

  it("only includes values for sort keys, not all entry fields", () => {
    const token = encodeSample();
    const decoded = decodeCursor(token, sort, KEYS, "things");

    expect(decoded.values).not.toHaveProperty("created_at");
  });

  it("preserves null sort values", () => {
    const token = encodeCursor(
      sample,
      [{ key: "title", direction: "asc" }] as const,
      (e) => e.id,
      () => null,
    );
    const decoded = decodeCursor(token, [{ key: "title", direction: "asc" }], KEYS, "things");

    expect(decoded.values.title).toBeNull();
  });

  it("rejects invalid base64url", () => {
    expect(() => decodeCursor("@@@not-base64@@@", sort, KEYS, "things")).toThrow(
      new CursorError("Invalid things cursor"),
    );
  });

  it("rejects valid base64url that is not JSON", () => {
    const token = Buffer.from("not json", "utf8").toString("base64url");
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(CursorError);
  });

  it("rejects JSON that is not an object", () => {
    const token = Buffer.from(JSON.stringify(["array"]), "utf8").toString("base64url");
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(CursorError);
  });

  it("rejects payload missing id", () => {
    const token = Buffer.from(
      JSON.stringify({ sort, values: { updated_at: 1, title: "x" } }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(CursorError);
  });

  it("rejects payload with non-string id", () => {
    const token = Buffer.from(
      JSON.stringify({ sort, values: { updated_at: 1, title: "x" }, id: 42 }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(CursorError);
  });

  it("rejects payload missing values", () => {
    const token = Buffer.from(JSON.stringify({ sort, id: "x" }), "utf8").toString("base64url");
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(CursorError);
  });

  it("rejects an unknown sort key", () => {
    const token = Buffer.from(
      JSON.stringify({
        sort: [{ key: "made_up", direction: "asc" }],
        values: {},
        id: "x",
      }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(CursorError);
  });

  it("rejects an invalid direction", () => {
    const token = Buffer.from(
      JSON.stringify({
        sort: [{ key: "title", direction: "sideways" }],
        values: {},
        id: "x",
      }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(CursorError);
  });

  it("rejects a cursor whose sort length does not match", () => {
    const token = encodeSample(sample, [{ key: "title", direction: "asc" }]);
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(
      new CursorError("things cursor does not match current sort"),
    );
  });

  it("rejects a cursor whose sort key order does not match", () => {
    const reversed: CursorSortEntry<Key>[] = [
      { key: "title", direction: "asc" },
      { key: "updated_at", direction: "desc" },
    ];
    const token = encodeSample(sample, reversed);
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(
      new CursorError("things cursor does not match current sort"),
    );
  });

  it("rejects a cursor whose sort direction does not match", () => {
    const flipped: CursorSortEntry<Key>[] = [
      { key: "updated_at", direction: "asc" },
      { key: "title", direction: "asc" },
    ];
    const token = encodeSample(sample, flipped);
    expect(() => decodeCursor(token, sort, KEYS, "things")).toThrow(
      new CursorError("things cursor does not match current sort"),
    );
  });

  it("uses the label in error messages", () => {
    expect(() => decodeCursor("@@@", sort, KEYS, "fetch_widgets")).toThrow(
      new CursorError("Invalid fetch_widgets cursor"),
    );
  });
});
