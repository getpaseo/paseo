import { describe, expect, it } from "vitest";
import {
  resolveHeaderRowContentWidth,
  type HeaderRowChildBox,
} from "@/components/desktop/window-chrome-header-row-measure";

const title: HeaderRowChildBox = { isAbsolute: false, canShrink: true, intrinsicWidth: 786 };
const actions: HeaderRowChildBox = { isAbsolute: false, canShrink: false, intrinsicWidth: 317 };
const dragRegion: HeaderRowChildBox = { isAbsolute: true, canShrink: true, intrinsicWidth: 1096 };

describe("header row content width", () => {
  it("ignores a title that grows to fill the row and truncates when squeezed", () => {
    // The real workspace header: 1103px of children in a 1096px row, of which only the trailing
    // 317px can collide with anything. Counting the title reported the row as full and dropped a
    // header with 639px to spare.
    expect(
      resolveHeaderRowContentWidth({
        children: [dragRegion, dragRegion, title, actions],
        gap: 0,
        horizontalPadding: 0,
      }),
    ).toBe(317);
  });

  it("counts every rigid child, because each one reaches the controls", () => {
    // The real explorer header: a tab list and a trailing toggle, both rigid.
    const tabs: HeaderRowChildBox = { isAbsolute: false, canShrink: false, intrinsicWidth: 211 };
    const toggle: HeaderRowChildBox = { isAbsolute: false, canShrink: false, intrinsicWidth: 34 };
    expect(
      resolveHeaderRowContentWidth({
        children: [dragRegion, tabs, toggle],
        gap: 0,
        horizontalPadding: 8,
      }),
    ).toBe(261);
  });

  it("adds a gap between rigid children only", () => {
    const rigid: HeaderRowChildBox = { isAbsolute: false, canShrink: false, intrinsicWidth: 50 };
    // Three rigid children have two gaps between them; the shrinkable one adds neither.
    expect(
      resolveHeaderRowContentWidth({
        children: [rigid, rigid, rigid, title],
        gap: 4,
        horizontalPadding: 0,
      }),
    ).toBe(158);
    expect(resolveHeaderRowContentWidth({ children: [rigid], gap: 4, horizontalPadding: 0 })).toBe(
      50,
    );
  });

  it("needs only its padding when nothing in the row is rigid", () => {
    expect(
      resolveHeaderRowContentWidth({
        children: [dragRegion, title],
        gap: 4,
        horizontalPadding: 12,
      }),
    ).toBe(24);
    expect(resolveHeaderRowContentWidth({ children: [], gap: 4, horizontalPadding: 0 })).toBe(0);
  });
});
