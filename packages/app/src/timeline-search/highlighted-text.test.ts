import { describe, expect, it } from "vitest";
import { isActiveHighlightSegment } from "./highlighted-text";
import type { HighlightSegment } from "./highlight";
import type { TimelineSearchTarget } from "./search-target";

function makeTarget(overrides: Partial<TimelineSearchTarget> = {}): TimelineSearchTarget {
  return {
    itemId: "item-1",
    field: "text",
    fieldOffset: 5,
    matchOffset: 5,
    matchLength: 4,
    navigationRevision: 1,
    ...overrides,
  };
}

function makeMatchSegment(overrides: Partial<HighlightSegment> = {}): HighlightSegment {
  return { offset: 5, text: "here", isMatch: true, ...overrides };
}

describe("isActiveHighlightSegment", () => {
  it("is true when itemId, field, and offset all match the target", () => {
    const target = makeTarget();
    expect(
      isActiveHighlightSegment(makeMatchSegment(), { itemId: "item-1", field: "text", target }),
    ).toBe(true);
  });

  it("is false when the segment is not a match, even if offset/field/itemId align", () => {
    const target = makeTarget();
    const segment = makeMatchSegment({ isMatch: false });
    expect(isActiveHighlightSegment(segment, { itemId: "item-1", field: "text", target })).toBe(
      false,
    );
  });

  it("is false when target is null", () => {
    expect(
      isActiveHighlightSegment(makeMatchSegment(), {
        itemId: "item-1",
        field: "text",
        target: null,
      }),
    ).toBe(false);
  });

  it("is false on itemId mismatch", () => {
    const target = makeTarget({ itemId: "item-1" });
    expect(
      isActiveHighlightSegment(makeMatchSegment(), { itemId: "item-2", field: "text", target }),
    ).toBe(false);
  });

  it("is false when itemId is undefined (caller didn't opt into active-match tracking)", () => {
    const target = makeTarget();
    expect(
      isActiveHighlightSegment(makeMatchSegment(), { itemId: undefined, field: "text", target }),
    ).toBe(false);
  });

  it("is false on field mismatch — a match in toolOutput must not activate a toolInput segment", () => {
    const target = makeTarget({ field: "toolOutput" });
    expect(
      isActiveHighlightSegment(makeMatchSegment(), {
        itemId: "item-1",
        field: "toolInput",
        target,
      }),
    ).toBe(false);
  });

  it("distinguishes per-entry todo fields — todo:0 must not activate todo:1's segment", () => {
    const target = makeTarget({ field: "todo:1", fieldOffset: 5 });
    expect(
      isActiveHighlightSegment(makeMatchSegment(), { itemId: "item-1", field: "todo:0", target }),
    ).toBe(false);
    expect(
      isActiveHighlightSegment(makeMatchSegment(), { itemId: "item-1", field: "todo:1", target }),
    ).toBe(true);
  });

  it("is false when the offset is off by one (boundary check, not a range)", () => {
    const target = makeTarget({ fieldOffset: 5 });
    expect(
      isActiveHighlightSegment(makeMatchSegment({ offset: 4 }), {
        itemId: "item-1",
        field: "text",
        target,
      }),
    ).toBe(false);
    expect(
      isActiveHighlightSegment(makeMatchSegment({ offset: 6 }), {
        itemId: "item-1",
        field: "text",
        target,
      }),
    ).toBe(false);
  });

  it("compares against fieldOffset, not matchOffset — a field-relative offset must not be", () => {
    // Regression guard for the original bug: matchOffset is the offset into
    // the item's cross-field CONCATENATED text, which is meaningless to a
    // renderer that owns one field's own text. A segment must only go active
    // when its offset matches fieldOffset, even if it happens to equal the
    // (irrelevant) matchOffset of a target in a different field's frame.
    const target = makeTarget({ field: "toolInput", fieldOffset: 20, matchOffset: 5 });
    // Segment offset equals target.matchOffset (5) but not target.fieldOffset (20).
    expect(
      isActiveHighlightSegment(makeMatchSegment({ offset: 5 }), {
        itemId: "item-1",
        field: "toolInput",
        target,
      }),
    ).toBe(false);
    // Segment offset equals target.fieldOffset (20) — this is the real match.
    expect(
      isActiveHighlightSegment(makeMatchSegment({ offset: 20 }), {
        itemId: "item-1",
        field: "toolInput",
        target,
      }),
    ).toBe(true);
  });
});
