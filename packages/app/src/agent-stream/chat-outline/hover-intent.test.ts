import { describe, expect, it } from "vitest";
import { createChatOutlineHoverIntent } from "./hover-intent";

function createFakeScheduler() {
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  let nextId = 1;
  return {
    schedule(callback: () => void, delayMs: number) {
      const id = nextId++;
      callbacks.set(id, callback);
      delays.push(delayMs);
      return id;
    },
    cancel(id: number) {
      callbacks.delete(id);
    },
    runPending() {
      for (const [id, callback] of callbacks) {
        callbacks.delete(id);
        callback();
      }
    },
    scheduleCount() {
      return delays.length;
    },
    delays() {
      return delays;
    },
  };
}

describe("chat outline hover intent", () => {
  it("counts movement across the rail toward one initial activation", () => {
    const scheduler = createFakeScheduler();
    const activations: Array<number | null> = [];
    const intent = createChatOutlineHoverIntent({
      activate: (index) => activations.push(index),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });

    intent.enter({ x: 20, y: 10 });
    intent.pointAt(1);
    intent.move({ x: 20, y: 30 });
    intent.pointAt(2);
    intent.move({ x: 20, y: 50 });
    intent.pointAt(3);
    scheduler.runPending();

    expect({
      activations,
      scheduleCount: scheduler.scheduleCount(),
      delays: scheduler.delays(),
    }).toEqual({
      activations: [3],
      scheduleCount: 1,
      delays: [150],
    });
  });

  it("does not activate while the pointer is crossing horizontally through the rail", () => {
    const scheduler = createFakeScheduler();
    const activations: Array<number | null> = [];
    const intent = createChatOutlineHoverIntent({
      activate: (index) => activations.push(index),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });

    intent.enter({ x: 36, y: 20 });
    intent.pointAt(1);
    intent.move({ x: 30, y: 20 });
    intent.move({ x: 24, y: 20 });
    intent.move({ x: 18, y: 20 });
    intent.leave();
    intent.enter({ x: 0, y: 20 });
    intent.pointAt(2);
    intent.move({ x: 6, y: 20 });
    intent.move({ x: 12, y: 20 });
    intent.leave();
    scheduler.runPending();

    expect({ activations, scheduleCount: scheduler.scheduleCount() }).toEqual({
      activations: [null, null],
      scheduleCount: 7,
    });
  });

  it("moves immediately between ticks after the rail activates", () => {
    const scheduler = createFakeScheduler();
    const activations: Array<number | null> = [];
    const intent = createChatOutlineHoverIntent({
      activate: (index) => activations.push(index),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });

    intent.pointAt(1);
    scheduler.runPending();
    intent.pointAt(5);

    expect(activations).toEqual([1, 5]);
  });

  it("resets activation when the pointer leaves the rail", () => {
    const scheduler = createFakeScheduler();
    const activations: Array<number | null> = [];
    const intent = createChatOutlineHoverIntent({
      activate: (index) => activations.push(index),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });

    intent.pointAt(1);
    scheduler.runPending();
    intent.leave();
    intent.pointAt(2);

    expect({ activations, scheduleCount: scheduler.scheduleCount() }).toEqual({
      activations: [1, null],
      scheduleCount: 2,
    });
  });
});
