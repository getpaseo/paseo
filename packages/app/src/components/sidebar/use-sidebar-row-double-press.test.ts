import { describe, expect, it, vi } from "vitest";
import { createSidebarRowPressHandler } from "./use-sidebar-row-double-press";

describe("createSidebarRowPressHandler", () => {
  it("calls onPress for a single press", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    const handler = createSidebarRowPressHandler({ onPress, onRename, now: () => 1000 });

    handler();

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("opens rename on a second press inside the window", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    let now = 1000;
    const handler = createSidebarRowPressHandler({ onPress, onRename, now: () => now });

    handler();
    now = 1200;
    handler();

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("treats two presses outside the window as two selections", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    let now = 1000;
    const handler = createSidebarRowPressHandler({ onPress, onRename, now: () => now });

    handler();
    now = 1400;
    handler();

    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("treats a press right after a rename as a fresh selection", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    let now = 1000;
    const handler = createSidebarRowPressHandler({ onPress, onRename, now: () => now });

    handler();
    now = 1100;
    handler();
    now = 1200;
    handler();

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("falls through to onPress when rename is unavailable", () => {
    const onPress = vi.fn();
    let now = 1000;
    const handler = createSidebarRowPressHandler({ onPress, now: () => now });

    handler();
    now = 1100;
    handler();

    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("swallows the press after a long press and starts timing over", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    const didLongPressRef = { current: false };
    let now = 1000;
    const handler = createSidebarRowPressHandler({
      onPress,
      onRename,
      didLongPressRef,
      now: () => now,
    });

    handler();
    didLongPressRef.current = true;
    now = 1100;
    handler();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();

    now = 1200;
    handler();
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onRename).not.toHaveBeenCalled();
  });
});
