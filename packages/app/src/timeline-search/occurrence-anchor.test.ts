import { describe, expect, it, vi } from "vitest";
import {
  createTimelineSearchOccurrenceAnchorController,
  getTimelineSearchOccurrenceAnchorKey,
  getTimelineSearchOccurrenceScrollDelta,
} from "./occurrence-anchor";
import type { TimelineSearchTarget } from "./search-target";

function makeTarget(overrides: Partial<TimelineSearchTarget> = {}): TimelineSearchTarget {
  return {
    itemId: "message-1",
    field: "text",
    fieldOffset: 12,
    matchOffset: 12,
    matchLength: 3,
    navigationRevision: 1,
    ...overrides,
  };
}

function createFrames() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    requestFrame(callback: () => void) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelFrame(handle: number) {
      callbacks.delete(handle);
    },
    flushOne() {
      const entry = callbacks.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error("Expected a scheduled frame");
      callbacks.delete(entry[0]);
      entry[1]();
    },
    get size() {
      return callbacks.size;
    },
  };
}

describe("timeline search occurrence anchor controller", () => {
  it("centres the selected occurrence after two layout frames", () => {
    const frames = createFrames();
    const scrollBy = vi.fn();
    const controller = createTimelineSearchOccurrenceAnchorController({
      scrollBy,
      getTargetCenterY: () => 400,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    const target = makeTarget();
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(target),
      measure: (report) => report(700),
    });
    controller.setTarget(target);

    frames.flushOne();
    expect(scrollBy).not.toHaveBeenCalled();
    frames.flushOne();
    expect(scrollBy).toHaveBeenCalledWith(300);
  });

  it("reads the current viewport center when the anchor measurement reports", () => {
    const frames = createFrames();
    const scrollBy = vi.fn();
    let targetCenterY = 400;
    const controller = createTimelineSearchOccurrenceAnchorController({
      scrollBy,
      getTargetCenterY: () => targetCenterY,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    const target = makeTarget();
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(target),
      measure: (report) => report(700),
    });
    controller.setTarget(target);

    frames.flushOne();
    targetCenterY = 520;
    frames.flushOne();

    expect(scrollBy).toHaveBeenCalledWith(180);
  });

  it("ignores a stale measurement when navigation changes before it completes", () => {
    const frames = createFrames();
    const scrollBy = vi.fn();
    const controller = createTimelineSearchOccurrenceAnchorController({
      scrollBy,
      getTargetCenterY: () => 400,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    const first = makeTarget();
    const second = makeTarget({ matchOffset: 64, navigationRevision: 2 });
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(first),
      measure: (report) => report(700),
    });
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(second),
      measure: (report) => report(500),
    });
    controller.setTarget(first);
    frames.flushOne();
    controller.setTarget(second);

    frames.flushOne();
    frames.flushOne();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith(100);
  });

  it("keeps distinct occurrences in one large item independently addressable", () => {
    const first = makeTarget({ matchOffset: 0 });
    const second = makeTarget({ matchOffset: 1200 });
    expect(getTimelineSearchOccurrenceAnchorKey(first)).not.toBe(
      getTimelineSearchOccurrenceAnchorKey(second),
    );
  });

  it("prefers an exact text anchor over a containing-block fallback", () => {
    const frames = createFrames();
    const scrollBy = vi.fn();
    const controller = createTimelineSearchOccurrenceAnchorController({
      scrollBy,
      getTargetCenterY: () => 400,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    const target = makeTarget();
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(target),
      priority: 1,
      measure: (report) => report(700),
    });
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(target),
      priority: 2,
      measure: (report) => report(480),
    });
    controller.setTarget(target);

    frames.flushOne();
    frames.flushOne();
    expect(scrollBy).toHaveBeenCalledWith(80);
  });

  it("does not move the viewport when the anchor is already centred", () => {
    expect(getTimelineSearchOccurrenceScrollDelta(416, 400)).toBe(0);
    expect(getTimelineSearchOccurrenceScrollDelta(425, 400)).toBe(25);
  });

  it("does not re-measure when setTarget is called again with an equivalent target for the same revision (e.g. a stream flush re-render)", () => {
    const frames = createFrames();
    const scrollBy = vi.fn();
    const controller = createTimelineSearchOccurrenceAnchorController({
      scrollBy,
      getTargetCenterY: () => 400,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    const target = makeTarget();
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(target),
      measure: (report) => report(700),
    });
    controller.setTarget(target);
    frames.flushOne();
    frames.flushOne();
    expect(scrollBy).toHaveBeenCalledTimes(1);

    // A stream flush that re-renders the provider hands the controller a
    // new-but-equal target object (same occurrence, same navigationRevision)
    // — this must not schedule another measurement or scroll.
    controller.setTarget({ ...target });
    expect(frames.size).toBe(0);
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next-priority anchor when the highest-priority one never reports", () => {
    const frames = createFrames();
    const scrollBy = vi.fn();
    const controller = createTimelineSearchOccurrenceAnchorController({
      scrollBy,
      getTargetCenterY: () => 400,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    const target = makeTarget();
    // The exact-span anchor never calls `report` — simulating a native
    // measureInWindow that silently fails (stale ref / unmounted node / a
    // consumer's own `?.()` swallowing a missing method).
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(target),
      priority: 2,
      measure: () => {},
    });
    controller.register({
      key: getTimelineSearchOccurrenceAnchorKey(target),
      priority: 1,
      measure: (report) => report(700),
    });
    controller.setTarget(target);

    frames.flushOne(); // first double-rAF frame for the priority-2 anchor
    frames.flushOne(); // second double-rAF frame — calls measure(), no report
    expect(scrollBy).not.toHaveBeenCalled();
    frames.flushOne(); // degrade-timeout frame — falls back to priority-1
    frames.flushOne(); // first double-rAF frame for the priority-1 anchor
    frames.flushOne(); // second double-rAF frame — calls measure(), reports
    expect(scrollBy).toHaveBeenCalledWith(300);
  });
});
