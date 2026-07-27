import { describe, expect, it, vi } from "vitest";
import { createHistoryStartSettleScheduler } from "./history-start-settle-scheduler";

describe("history start settle scheduler", () => {
  it("does not restart its countdown when geometry keeps changing", () => {
    const frames = new Map<number, () => void>();
    let nextFrameId = 1;
    const onSettle = vi.fn();
    const scheduler = createHistoryStartSettleScheduler({
      settleFrames: 2,
      requestFrame(callback) {
        const id = nextFrameId;
        nextFrameId += 1;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: (id) => frames.delete(id),
      isSettling: () => true,
      isLoading: () => false,
      onSettle,
    });
    const runNextFrame = () => {
      const next = frames.entries().next().value as [number, () => void] | undefined;
      if (!next) {
        throw new Error("Expected a scheduled settlement frame");
      }
      frames.delete(next[0]);
      next[1]();
    };

    scheduler.schedule();
    scheduler.schedule();
    runNextFrame();
    scheduler.schedule();
    runNextFrame();
    scheduler.schedule();
    runNextFrame();

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });
});
