import { describe, expect, it, vi } from "vitest";
import {
  dismissTopNativeOverlay,
  dispatchTopNativeOverlayKey,
  getTopNativeOverlayKeys,
  hasActiveNativeOverlay,
  registerNativeOverlay,
  subscribeNativeOverlays,
} from "./overlay-root";

/** Stands in for an overlay that only closes on Escape. */
function dismissOnly(onDismiss: () => void) {
  return (key: string) => {
    if (key !== "Escape") return false;
    onDismiss();
    return true;
  };
}

describe("native overlay key stack", () => {
  it("reports nothing to dismiss when empty", () => {
    expect(hasActiveNativeOverlay()).toBe(false);
    expect(dismissTopNativeOverlay()).toBe(false);
    expect(getTopNativeOverlayKeys()).toEqual([]);
  });

  it("dismisses the only registered overlay", () => {
    const onDismiss = vi.fn();
    const release = registerNativeOverlay({
      getLayer: () => 20,
      handleKey: dismissOnly(onDismiss),
    });

    expect(hasActiveNativeOverlay()).toBe(true);
    expect(dismissTopNativeOverlay()).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    release();
    expect(hasActiveNativeOverlay()).toBe(false);
  });

  it("falls through for a key the overlay does not want", () => {
    const release = registerNativeOverlay({
      getLayer: () => 20,
      handleKey: dismissOnly(() => {}),
    });

    expect(dispatchTopNativeOverlayKey("ArrowUp")).toBe(false);

    release();
  });

  it("dismisses the higher layer first, so a menu inside a modal closes before the modal", () => {
    const modal = vi.fn();
    const menu = vi.fn();
    const releaseModal = registerNativeOverlay({
      getLayer: () => 20,
      handleKey: dismissOnly(modal),
    });
    const releaseMenu = registerNativeOverlay({
      getLayer: () => 30,
      handleKey: dismissOnly(menu),
    });

    dismissTopNativeOverlay();
    expect(menu).toHaveBeenCalledTimes(1);
    expect(modal).not.toHaveBeenCalled();

    releaseMenu();
    dismissTopNativeOverlay();
    expect(modal).toHaveBeenCalledTimes(1);

    releaseModal();
  });

  it("breaks a layer tie on registration order, newest first", () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = registerNativeOverlay({
      getLayer: () => 20,
      handleKey: dismissOnly(first),
    });
    const releaseSecond = registerNativeOverlay({
      getLayer: () => 20,
      handleKey: dismissOnly(second),
    });

    dismissTopNativeOverlay();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    releaseFirst();
    releaseSecond();
  });

  it("reports only the topmost overlay's keys", () => {
    const releaseModal = registerNativeOverlay({
      getLayer: () => 20,
      getKeys: () => ["Enter"],
      handleKey: () => true,
    });
    expect(getTopNativeOverlayKeys()).toEqual(["Enter"]);

    const releaseMenu = registerNativeOverlay({
      getLayer: () => 30,
      getKeys: () => ["ArrowUp", "ArrowDown"],
      handleKey: () => true,
    });
    // The modal's Enter must not stay registered while the menu is on top: it
    // would be taken from whatever holds focus for an overlay that cannot see it.
    expect(getTopNativeOverlayKeys()).toEqual(["ArrowUp", "ArrowDown"]);

    releaseMenu();
    expect(getTopNativeOverlayKeys()).toEqual(["Enter"]);

    releaseModal();
    expect(getTopNativeOverlayKeys()).toEqual([]);
  });

  it("routes a requested key to the topmost overlay", () => {
    const onKey = vi.fn().mockReturnValue(true);
    const release = registerNativeOverlay({
      getLayer: () => 20,
      getKeys: () => ["ArrowDown"],
      handleKey: onKey,
    });

    expect(dispatchTopNativeOverlayKey("ArrowDown")).toBe(true);
    expect(onKey).toHaveBeenCalledWith("ArrowDown");

    release();
  });

  it("notifies subscribers as the stack fills and empties", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNativeOverlays(listener);

    const release = registerNativeOverlay({ getLayer: () => 20, handleKey: () => false });
    expect(listener).toHaveBeenCalledTimes(1);

    release();
    expect(listener).toHaveBeenCalledTimes(2);

    // A release that already ran must not announce a change that did not happen.
    release();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registerNativeOverlay({ getLayer: () => 20, handleKey: () => false })();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
