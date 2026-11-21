import { describe, expect, it } from "vitest";
import {
  beginSidebarResize,
  createSidebarResizeGate,
  endSidebarResize,
  isSidebarResizeActive,
  resolveSidebarResizeLeadingShift,
  resolveSidebarResizePreviewOffset,
  resolveSidebarResizeTrailingShift,
  SIDEBAR_RESIZE_SLAB,
  subscribeSidebarResizeEnd,
} from "@/components/sidebar-resize-activity";

describe("sidebar resize activity", () => {
  it("is active from the first begin until the matching end", () => {
    expect(isSidebarResizeActive()).toBe(false);
    beginSidebarResize();
    expect(isSidebarResizeActive()).toBe(true);
    endSidebarResize();
    expect(isSidebarResizeActive()).toBe(false);
  });

  it("stays active while overlapping drags are still running", () => {
    beginSidebarResize();
    beginSidebarResize();
    endSidebarResize();
    expect(isSidebarResizeActive()).toBe(true);
    endSidebarResize();
    expect(isSidebarResizeActive()).toBe(false);
  });

  it("ignores an end without a begin", () => {
    endSidebarResize();
    expect(isSidebarResizeActive()).toBe(false);
    beginSidebarResize();
    expect(isSidebarResizeActive()).toBe(true);
    endSidebarResize();
    expect(isSidebarResizeActive()).toBe(false);
  });

  it("notifies end listeners once the last drag ends, until they unsubscribe", () => {
    const ends: boolean[] = [];
    const unsubscribe = subscribeSidebarResizeEnd(() => ends.push(isSidebarResizeActive()));
    beginSidebarResize();
    beginSidebarResize();
    endSidebarResize();
    expect(ends).toEqual([]);
    endSidebarResize();
    expect(ends).toEqual([false]);
    endSidebarResize();
    expect(ends).toEqual([false]);
    unsubscribe();
    beginSidebarResize();
    endSidebarResize();
    expect(ends).toEqual([false]);
  });
});

describe("sidebar resize gate", () => {
  function gateWithLog() {
    const applied: number[] = [];
    const gate = createSidebarResizeGate<number>((value) => applied.push(value));
    const unsubscribe = subscribeSidebarResizeEnd(gate.flush);
    return { applied, gate, unsubscribe };
  }

  it("applies values right away while no drag runs", () => {
    const { applied, gate, unsubscribe } = gateWithLog();
    gate.offer(1);
    gate.offer(2);
    expect(applied).toEqual([1, 2]);
    unsubscribe();
  });

  // A drag that crosses a layout threshold several times must switch layout once, where it ends.
  it("holds values during a drag and applies only the last one when it ends", () => {
    const { applied, gate, unsubscribe } = gateWithLog();
    beginSidebarResize();
    gate.offer(1);
    gate.offer(2);
    gate.offer(3);
    expect(applied).toEqual([]);
    endSidebarResize();
    expect(applied).toEqual([3]);
    endSidebarResize();
    expect(applied).toEqual([3]);
    unsubscribe();
  });

  it("applies nothing at the end of a drag that offered nothing", () => {
    const { applied, gate, unsubscribe } = gateWithLog();
    gate.offer(1);
    beginSidebarResize();
    endSidebarResize();
    expect(applied).toEqual([1]);
    unsubscribe();
  });

  it("drops a held value once a later offer lands after the drag", () => {
    const { applied, gate, unsubscribe } = gateWithLog();
    unsubscribe();
    beginSidebarResize();
    gate.offer(1);
    endSidebarResize();
    gate.offer(2);
    gate.flush();
    expect(applied).toEqual([2]);
  });
});

describe("sidebar resize preview offset", () => {
  it("measures from the committed edge in the direction the panel grows", () => {
    expect(
      resolveSidebarResizePreviewOffset({ grows: "right", committedWidth: 320, targetWidth: 400 }),
    ).toBe(80);
    expect(
      resolveSidebarResizePreviewOffset({ grows: "right", committedWidth: 320, targetWidth: 200 }),
    ).toBe(-120);
    expect(
      resolveSidebarResizePreviewOffset({ grows: "left", committedWidth: 260, targetWidth: 300 }),
    ).toBe(-40);
    expect(
      resolveSidebarResizePreviewOffset({ grows: "left", committedWidth: 260, targetWidth: 200 }),
    ).toBe(60);
  });
});

describe("sidebar resize slab shift", () => {
  it("parks the leading slab so its right edge is the dragged edge", () => {
    expect(resolveSidebarResizeLeadingShift(80)).toBe(80 - SIDEBAR_RESIZE_SLAB);
    expect(resolveSidebarResizeLeadingShift(0)).toBe(-SIDEBAR_RESIZE_SLAB);
    expect(resolveSidebarResizeLeadingShift(-40)).toBe(-40 - SIDEBAR_RESIZE_SLAB);
  });

  it("shows only the gap on the right and stays off-screen when the pane shifts right", () => {
    expect(resolveSidebarResizeTrailingShift(-120)).toBe(SIDEBAR_RESIZE_SLAB - 120);
    expect(resolveSidebarResizeTrailingShift(80)).toBe(SIDEBAR_RESIZE_SLAB);
    expect(resolveSidebarResizeTrailingShift(0)).toBe(SIDEBAR_RESIZE_SLAB);
  });
});
