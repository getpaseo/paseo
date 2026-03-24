import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusWithRetries } from "./web-focus";

describe("focusWithRetries", () => {
  let frameQueue: FrameRequestCallback[] = [];
  let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;

  beforeEach(() => {
    frameQueue = [];
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameQueue.push(callback);
      return frameQueue.length;
    }) as typeof requestAnimationFrame;
  });

  afterEach(() => {
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      return;
    }

    delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
      .requestAnimationFrame;
  });

  function flushAnimationFrames(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const callbacks = frameQueue;
      frameQueue = [];
      for (const callback of callbacks) {
        callback(index);
      }
    }
  }

  it("tries to focus immediately before waiting for animation frames", () => {
    let focused = false;
    const focus = vi.fn(() => {
      focused = true;
    });
    const onSuccess = vi.fn();

    focusWithRetries({
      focus,
      isFocused: () => focused,
      onSuccess,
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(frameQueue).toHaveLength(0);
  });

  it("keeps retrying on later animation frames until focus succeeds", () => {
    let focused = false;
    let attempts = 0;
    const focus = vi.fn(() => {
      attempts += 1;
      if (attempts >= 3) {
        focused = true;
      }
    });
    const onSuccess = vi.fn();

    focusWithRetries({
      focus,
      isFocused: () => focused,
      onSuccess,
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();

    flushAnimationFrames(2);
    expect(focus).toHaveBeenCalledTimes(2);
    expect(onSuccess).not.toHaveBeenCalled();

    flushAnimationFrames(2);
    expect(focus).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after cancellation", () => {
    const focus = vi.fn();

    const cancel = focusWithRetries({
      focus,
      isFocused: () => false,
    });

    expect(focus).toHaveBeenCalledTimes(1);

    cancel();
    flushAnimationFrames(4);

    expect(focus).toHaveBeenCalledTimes(1);
  });
});
