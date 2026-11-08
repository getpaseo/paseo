import { describe, expect, it } from "vitest";
import {
  createNativeDisclosureHold,
  disclosureAnchor,
  createEndHoldDistance,
  type DisclosureAnchor,
} from "./native-disclosure-hold";

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

    hold.hold({ kind: "row", rowId: "turn-1" });
    frames.runFrame();

    expect(hold.anchorRowId()).toBe("turn-1");
    expect(releases).toEqual([]);

    frames.runFrame();

    expect(hold.anchorRowId()).toBeNull();
    expect(releases).toEqual(["released"]);
  });

  it("restarts the quiet frames on every item size change", () => {
    const { frames, hold, releases } = createHarness();

    hold.hold({ kind: "row", rowId: "turn-1" });
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

    hold.hold({ kind: "row", rowId: "turn-1" });
    frames.runFrame();
    hold.hold({ kind: "row", rowId: "turn-2" });

    expect(hold.anchorRowId()).toBe("turn-2");

    frames.runFrame();
    frames.runFrame();

    expect(releases).toEqual(["released"]);
  });

  it("drops the hold without releasing when cancelled", () => {
    const { frames, hold, releases } = createHarness();

    hold.hold({ kind: "row", rowId: "turn-1" });
    hold.cancel();
    frames.runFrame();
    frames.runFrame();

    expect(hold.anchorRowId()).toBeNull();
    expect(releases).toEqual([]);
  });

  it("holds the content end until two quiet frames pass, with no row to anchor on", () => {
    const { frames, hold, releases } = createHarness();

    hold.hold({ kind: "end" });
    frames.runFrame();
    hold.noteItemSizeChanged();
    frames.runFrame();

    expect(hold.anchorRowId()).toBeNull();
    expect(releases).toEqual([]);

    frames.runFrame();

    expect(releases).toEqual(["released"]);
  });
});

describe("next-frame disclosure hold", () => {
  it("anchors the row a reply landed as while the toggle waited for its frame", () => {
    const { frames, hold } = createHarness();
    let anchor: DisclosureAnchor = { kind: "end" };
    const applied: DisclosureAnchor[] = [];

    hold.holdNextFrame(
      () => anchor,
      (resolved) => applied.push(resolved),
    );
    expect(applied).toEqual([]);

    anchor = { kind: "row", rowId: "turn-2" };
    frames.runFrame();

    expect(hold.anchorRowId()).toBe("turn-2");
    expect(applied).toEqual([{ kind: "row", rowId: "turn-2" }]);
  });

  it("still lands the toggle when the hold is cancelled before its frame", () => {
    const { frames, hold, releases } = createHarness();
    const applied: DisclosureAnchor[] = [];

    hold.holdNextFrame(
      () => ({ kind: "end" }),
      (resolved) => applied.push(resolved),
    );
    hold.cancel();
    frames.runFrame();
    frames.runFrame();

    expect(applied).toEqual([{ kind: "end" }]);
    expect(releases).toEqual([]);
  });

  it("lands a waiting toggle before the next hold starts", () => {
    const { frames, hold } = createHarness();
    const applied: DisclosureAnchor[] = [];

    hold.holdNextFrame(
      () => ({ kind: "end" }),
      (resolved) => applied.push(resolved),
    );
    hold.hold({ kind: "row", rowId: "turn-1" });

    expect(applied).toEqual([{ kind: "end" }]);
    frames.runFrame();
    expect(applied).toEqual([{ kind: "end" }]);
    expect(hold.anchorRowId()).toBe("turn-1");
  });
});

describe("disclosure anchor", () => {
  const rows = [{ id: "message-1" }, { id: "turn-1" }, { id: "message-2" }];

  it("keeps the top of a row whose trigger sits on its top edge", () => {
    expect(disclosureAnchor(rows, "turn-1", "top")).toEqual({ kind: "row", rowId: "turn-1" });
  });

  it("keeps the top of the row below a row whose trigger sits on its bottom edge", () => {
    expect(disclosureAnchor(rows, "message-1", "bottom")).toEqual({
      kind: "row",
      rowId: "turn-1",
    });
  });

  // A prompt the agent has not answered yet is the last row; the running indicator is the footer.
  it("keeps the content end for a bottom-edge trigger on the last row", () => {
    expect(disclosureAnchor(rows, "message-2", "bottom")).toEqual({ kind: "end" });
  });

  // The strategy re-derives this each render, so a reply lets go of the end in the commit it lands.
  it("stops keeping the content end once a reply lands below the row", () => {
    expect(disclosureAnchor([...rows, { id: "turn-2" }], "message-2", "bottom")).toEqual({
      kind: "row",
      rowId: "turn-2",
    });
  });
});

describe("end hold distance", () => {
  const viewportHeight = 600;

  it("keeps the distance from the end the toggle started at", () => {
    const distance = createEndHoldDistance(20);

    distance.noteContentSize({ contentHeight: 2000, viewportHeight });

    expect(distance.current()).toBe(20);
  });

  it("shrinks to the scroll room a collapse leaves", () => {
    const distance = createEndHoldDistance(20);

    distance.noteContentSize({ contentHeight: 610, viewportHeight });

    expect(distance.current()).toBe(10);
  });

  it("stays at the end when output grows the content after a collapse reached the end", () => {
    const distance = createEndHoldDistance(20);

    distance.noteContentSize({ contentHeight: 600, viewportHeight });
    distance.noteContentSize({ contentHeight: 700, viewportHeight });

    expect(distance.current()).toBe(0);
  });
});
