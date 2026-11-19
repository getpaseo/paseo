import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDragHold } from "./drag-hold";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function hold() {
  const onArm = vi.fn();
  return { onArm, hold: createDragHold({ delayMs: 180, slopPx: 4, onArm }) };
}

describe("createDragHold", () => {
  it("arms once the finger has stayed within the slop for the delay", () => {
    const { onArm, hold: dragHold } = hold();
    dragHold.begin({ x: 10, y: 10 });
    dragHold.move({ x: 12, y: 13 });
    vi.advanceTimersByTime(180);

    expect(onArm).toHaveBeenCalledTimes(1);
  });

  it("never arms when the finger moves past the slop first, as when a scroll starts", () => {
    const { onArm, hold: dragHold } = hold();
    dragHold.begin({ x: 10, y: 10 });
    dragHold.move({ x: 10, y: 20 });
    vi.advanceTimersByTime(500);

    expect(onArm).not.toHaveBeenCalled();
  });

  it("never arms when the finger lifts before the delay", () => {
    const { onArm, hold: dragHold } = hold();
    dragHold.begin({ x: 10, y: 10 });
    vi.advanceTimersByTime(100);
    dragHold.cancel();
    vi.advanceTimersByTime(500);

    expect(onArm).not.toHaveBeenCalled();
  });
});
