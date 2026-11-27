import { expect, it } from "vitest";
import { createInitialDrawDistanceExpansion } from "./initial-draw-distance";

function mountInitialBuffer() {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  const expansions: string[] = [];
  const buffer = createInitialDrawDistanceExpansion(
    {
      requestFrame(callback) {
        const id = ++nextId;
        pending.set(id, callback);
        return id;
      },
      cancelFrame(id) {
        pending.delete(id);
      },
    },
    () => expansions.push("full draw distance"),
  );
  function advanceFrame() {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback();
  }
  return { buffer, expansions, advanceFrame };
}

it("requests the full draw distance after two frame callbacks once the reveal is eligible", () => {
  const { buffer, expansions, advanceFrame } = mountInitialBuffer();
  buffer.schedule();
  advanceFrame();
  expect(expansions).toEqual([]);
  advanceFrame();
  expect(expansions).toEqual(["full draw distance"]);
});

it.each([0, 1])(
  "leaves initial draw distance in place during a gesture after %i frames",
  (elapsed) => {
    const { buffer, expansions, advanceFrame } = mountInitialBuffer();
    buffer.schedule();
    if (elapsed === 1) advanceFrame();

    buffer.pauseForScroll();
    advanceFrame();
    advanceFrame();
    expect(expansions).toEqual([]);

    buffer.resumeAfterScroll();
    advanceFrame();
    expect(expansions).toEqual([]);
    advanceFrame();
    expect(expansions).toEqual(["full draw distance"]);
  },
);

it("cancels a covered reveal and schedules again when it is eligible", () => {
  const { buffer, expansions, advanceFrame } = mountInitialBuffer();
  const cancel = buffer.schedule();
  advanceFrame();
  cancel();
  advanceFrame();
  expect(expansions).toEqual([]);

  buffer.schedule();
  advanceFrame();
  advanceFrame();
  expect(expansions).toEqual(["full draw distance"]);
});

it("keeps a covered list at its initial draw distance when a gesture ends", () => {
  const { buffer, expansions, advanceFrame } = mountInitialBuffer();
  buffer.pauseForScroll();
  const cover = buffer.schedule();
  advanceFrame();
  advanceFrame();
  expect(expansions).toEqual([]);

  cover();
  buffer.resumeAfterScroll();
  advanceFrame();
  advanceFrame();
  expect(expansions).toEqual([]);
});
