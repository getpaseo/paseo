import { describe, expect, it } from "vitest";
import { createNativeDisclosureHold } from "./native-disclosure-hold";

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
  };
}

function createHarness() {
  const frames = createFrames();
  const releases: string[] = [];
  const hold = createNativeDisclosureHold({
    quietFrames: 2,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    onRelease: () => releases.push("released"),
  });
  return { frames, hold, releases };
}

describe("native disclosure hold", () => {
  it("holds the row until two frames pass without an item size change", () => {
    const { frames, hold, releases } = createHarness();

    hold.hold("turn-1");
    frames.runFrame();

    expect(hold.heldRowId()).toBe("turn-1");
    expect(releases).toEqual([]);

    frames.runFrame();

    expect(hold.heldRowId()).toBeNull();
    expect(releases).toEqual(["released"]);
  });

  it("restarts the quiet frames on every item size change", () => {
    const { frames, hold, releases } = createHarness();

    hold.hold("turn-1");
    frames.runFrame();
    hold.noteItemSizeChanged();
    frames.runFrame();

    expect(releases).toEqual([]);

    frames.runFrame();

    expect(releases).toEqual(["released"]);
  });

  it("ignores item size changes outside a hold", () => {
    const { frames, hold, releases } = createHarness();

    hold.noteItemSizeChanged();
    frames.runFrame();
    frames.runFrame();

    expect(releases).toEqual([]);
  });

  it("moves the hold to the latest toggled row and releases once", () => {
    const { frames, hold, releases } = createHarness();

    hold.hold("turn-1");
    frames.runFrame();
    hold.hold("turn-2");

    expect(hold.heldRowId()).toBe("turn-2");

    frames.runFrame();
    frames.runFrame();

    expect(releases).toEqual(["released"]);
  });

  it("drops the hold without releasing when cancelled", () => {
    const { frames, hold, releases } = createHarness();

    hold.hold("turn-1");
    hold.cancel();
    frames.runFrame();
    frames.runFrame();

    expect(hold.heldRowId()).toBeNull();
    expect(releases).toEqual([]);
  });
});
