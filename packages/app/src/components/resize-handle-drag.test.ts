import { describe, expect, it, vi } from "vitest";
import { startResizeHandleDrag } from "@/components/resize-handle-drag";

interface FakeFrameScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(frameId: number): void;
  runNextFrame(): void;
  runLastRequestedFrame(): void;
  pendingFrameCount(): number;
  canceledFrameIds(): number[];
}

function createFakeFrameScheduler(): FakeFrameScheduler {
  const pendingFrames = new Map<number, () => void>();
  const canceledFrameIds: number[] = [];
  let lastRequestedFrame: (() => void) | null = null;
  let nextFrameId = 1;

  return {
    requestFrame(callback) {
      const frameId = nextFrameId;
      nextFrameId += 1;
      pendingFrames.set(frameId, callback);
      lastRequestedFrame = callback;
      return frameId;
    },
    cancelFrame(frameId) {
      canceledFrameIds.push(frameId);
      pendingFrames.delete(frameId);
    },
    runNextFrame() {
      const nextFrame = pendingFrames.entries().next().value;
      if (!nextFrame) {
        throw new Error("Expected a pending resize preview frame");
      }
      const [frameId, callback] = nextFrame;
      pendingFrames.delete(frameId);
      callback();
    },
    runLastRequestedFrame() {
      if (!lastRequestedFrame) {
        throw new Error("Expected a requested resize preview frame");
      }
      lastRequestedFrame();
    },
    pendingFrameCount() {
      return pendingFrames.size;
    },
    canceledFrameIds() {
      return canceledFrameIds;
    },
  };
}

describe("startResizeHandleDrag", () => {
  it("previews multiple moves once per frame using the latest size", () => {
    const frameScheduler = createFakeFrameScheduler();
    const preview = vi.fn();
    const commit = vi.fn();
    const drag = startResizeHandleDrag({
      sizes: [0.5, 0.5],
      index: 0,
      preview,
      commit,
      frameScheduler,
    });

    drag.move(0.05);
    drag.move(0.1);

    expect(frameScheduler.pendingFrameCount()).toBe(1);
    expect(preview).not.toHaveBeenCalled();

    frameScheduler.runNextFrame();

    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0]?.[0][0]).toBeCloseTo(0.6, 10);
    expect(preview.mock.calls[0]?.[0][1]).toBeCloseTo(0.4, 10);
    expect(commit).not.toHaveBeenCalled();
  });

  it("finishes a queued frame with one synchronous preview and one commit", () => {
    const frameScheduler = createFakeFrameScheduler();
    const preview = vi.fn();
    const commit = vi.fn();
    const drag = startResizeHandleDrag({
      sizes: [0.5, 0.5],
      index: 0,
      preview,
      commit,
      frameScheduler,
    });

    drag.move(0.05);
    drag.move(0.1);

    drag.finish();

    expect(frameScheduler.canceledFrameIds()).toEqual([1]);
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0]?.[0][0]).toBeCloseTo(0.6, 10);
    expect(preview.mock.calls[0]?.[0][1]).toBeCloseTo(0.4, 10);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0][0]).toBeCloseTo(0.6, 10);
    expect(commit.mock.calls[0]?.[0][1]).toBeCloseTo(0.4, 10);

    frameScheduler.runLastRequestedFrame();

    expect(preview).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });
});
