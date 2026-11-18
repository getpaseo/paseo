import { describe, expect, it } from "vitest";
import { createScenePlayer, type Frames } from "./player";

/** A page clock that moves only when the test turns it. */
function handClock() {
  let time = 0;
  let nextId = 0;
  const waiting = new Map<number, (now: number) => void>();
  const frames: Frames = {
    now: () => time,
    request(callback) {
      nextId += 1;
      waiting.set(nextId, callback);
      return nextId;
    },
    cancel: (id) => waiting.delete(id),
    reducedMotion: () => false,
  };
  return {
    frames,
    /** Moves the clock on and runs the frames that were waiting for it. */
    advance(ms: number) {
      time += ms;
      const due = [...waiting.values()];
      waiting.clear();
      for (const callback of due) callback(time);
    },
    framesWaiting: () => waiting.size,
  };
}

function setUp() {
  const clock = handClock();
  const player = createScenePlayer("orchestrate", { orchestrate: 1000, review: 500 }, clock.frames);
  return { clock, player };
}

describe("scene player", () => {
  it("plays the opening scene from the start when the page starts it", () => {
    const { clock, player } = setUp();
    player.start();
    clock.advance(16);
    clock.advance(16);
    expect(player.elapsed("orchestrate")).toBe(32);
  });

  it("keeps the place of a scene that a pill click started before the page did", () => {
    const { clock, player } = setUp();
    player.select("review");
    clock.advance(16);
    clock.advance(16);
    expect(player.elapsed("review")).toBe(32);

    player.start();
    expect(player.scene()).toBe("review");
    expect(player.elapsed("review")).toBe(32);
    expect(player.elapsed("orchestrate")).toBe(0);
  });

  it("stops the clock", () => {
    const { clock, player } = setUp();
    player.start();
    clock.advance(16);
    expect(clock.framesWaiting()).toBe(1);

    player.stop();
    expect(clock.framesWaiting()).toBe(0);
    clock.advance(16);
    expect(player.elapsed("orchestrate")).toBe(16);
  });
});
