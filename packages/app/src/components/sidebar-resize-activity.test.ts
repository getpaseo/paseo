import { describe, expect, it } from "vitest";
import {
  beginSidebarResize,
  createSidebarResizeGate,
  endSidebarResize,
  isSidebarResizeActive,
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
