import { describe, expect, it } from "vitest";
import { createNativeStartHold } from "./native-start-hold";

function createFrames() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    requestFrame: (callback: () => void) => {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    cancelFrame: (id: number) => {
      pending.delete(id);
    },
    runFrame: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    pendingCount: () => pending.size,
  };
}

function createHarness(options?: { maxFrames?: number }) {
  const frames = createFrames();
  let offset = 1600;
  let scrolls = 0;
  const holdingChanges: boolean[] = [];
  const hold = createNativeStartHold({
    quietFrames: 3,
    maxFrames: options?.maxFrames ?? 60,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    readOffset: () => offset,
    scrollToStart: () => {
      scrolls += 1;
      offset = 0;
    },
    onHoldingChange: (holding) => holdingChanges.push(holding),
  });
  return {
    frames,
    hold,
    scrolls: () => scrolls,
    holdingChanges,
    moveList: (next: number) => {
      offset = next;
    },
  };
}

describe("native start hold", () => {
  it("scrolls to the start and releases after the list stays there for the quiet frames", () => {
    const { frames, hold, scrolls, holdingChanges } = createHarness();

    hold.hold();

    expect(scrolls()).toBe(1);
    expect(hold.isHolding()).toBe(true);

    frames.runFrame();
    frames.runFrame();

    expect(hold.isHolding()).toBe(true);

    frames.runFrame();

    expect(hold.isHolding()).toBe(false);
    expect(frames.pendingCount()).toBe(0);
    expect(holdingChanges).toEqual([true, false]);
  });

  it("returns to the start when the list moves itself and restarts the quiet frames", () => {
    const { frames, hold, scrolls, moveList } = createHarness();

    hold.hold();
    frames.runFrame();
    moveList(123);
    frames.runFrame();

    expect(scrolls()).toBe(2);

    frames.runFrame();
    frames.runFrame();

    expect(hold.isHolding()).toBe(true);

    frames.runFrame();

    expect(hold.isHolding()).toBe(false);
  });

  it("lets go after the frame limit when the list never settles", () => {
    const { frames, hold, moveList } = createHarness({ maxFrames: 5 });

    hold.hold();
    for (let frame = 0; frame < 5; frame += 1) {
      moveList(123);
      frames.runFrame();
    }

    expect(hold.isHolding()).toBe(false);
    expect(frames.pendingCount()).toBe(0);
  });

  it("stops immediately when cancelled", () => {
    const { frames, hold, scrolls, moveList, holdingChanges } = createHarness();

    hold.hold();
    hold.cancel();
    moveList(123);
    frames.runFrame();

    expect(scrolls()).toBe(1);
    expect(hold.isHolding()).toBe(false);
    expect(holdingChanges).toEqual([true, false]);
  });
});
