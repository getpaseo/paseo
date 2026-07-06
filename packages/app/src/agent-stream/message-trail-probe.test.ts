import { describe, expect, it } from "vitest";
import { computeTrailAnchor } from "./message-trail-probe";

function createOffsetResolver(offsets: Record<string, number | null>) {
  const map = new Map<string, number | null>(Object.entries(offsets));
  return (id: string): number | null => map.get(id) ?? null;
}

describe("computeTrailAnchor", () => {
  it("marks the last user row at/above the reading line as current", () => {
    const scrollTop = 0;
    const clientHeight = 1000;
    // reading line = 0 + 1000 * 0.25 = 250
    const resolveOffset = createOffsetResolver({ u1: 0, u2: 250, u3: 400 });

    expect(
      computeTrailAnchor({
        ids: ["u1", "u2", "u3"],
        scrollTop,
        clientHeight,
        isAtBottom: false,
        resolveOffset,
      }),
    ).toEqual({ currentId: "u2" });
  });

  it("returns null currentId when no row has reached the reading line", () => {
    const resolveOffset = createOffsetResolver({ u1: 300, u2: 500 });

    expect(
      computeTrailAnchor({
        ids: ["u1", "u2"],
        scrollTop: 0,
        clientHeight: 1000,
        isAtBottom: false,
        resolveOffset,
      }),
    ).toEqual({ currentId: null });
  });

  it("skips ids whose offset resolver returns null", () => {
    const resolveOffset = createOffsetResolver({ u1: 0, u2: null, u3: 200 });

    expect(
      computeTrailAnchor({
        ids: ["u1", "u2", "u3"],
        scrollTop: 0,
        clientHeight: 1000,
        isAtBottom: false,
        resolveOffset,
      }),
    ).toEqual({ currentId: "u3" });
  });

  it("snaps current to the last id when isAtBottom is true", () => {
    const resolveOffset = createOffsetResolver({ u1: 0, u2: 100, u3: 900 });

    expect(
      computeTrailAnchor({
        ids: ["u1", "u2", "u3"],
        scrollTop: 0,
        clientHeight: 1000,
        isAtBottom: true,
        resolveOffset,
      }),
    ).toEqual({ currentId: "u3" });
  });

  it("keeps the reading-line result when isAtBottom is false", () => {
    const resolveOffset = createOffsetResolver({ u1: 0, u2: 100, u3: 900 });

    expect(
      computeTrailAnchor({
        ids: ["u1", "u2", "u3"],
        scrollTop: 0,
        clientHeight: 1000,
        isAtBottom: false,
        resolveOffset,
      }),
    ).toEqual({ currentId: "u2" });
  });

  it("returns { currentId: null } for an empty id list", () => {
    const resolveOffset = createOffsetResolver({});

    expect(
      computeTrailAnchor({
        ids: [],
        scrollTop: 0,
        clientHeight: 1000,
        isAtBottom: true,
        resolveOffset,
      }),
    ).toEqual({ currentId: null });
  });
});
