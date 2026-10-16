/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Platform, type GestureResponderEvent } from "react-native";
import { IOS_TEARDOWN_GRACE_MS, useMenuState } from "./menu-context";

/**
 * `Platform.OS` is a plain property on the react-native-web double, so the iOS branch is
 * reachable by writing to it. The grace period only exists on iOS, which is exactly the platform
 * whose selections used to be dropped.
 */
const originalPlatform = Platform.OS;

function setPlatform(os: string) {
  Object.assign(Platform, { OS: os });
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  setPlatform(originalPlatform);
});

describe("useMenuState selectItem on iOS", () => {
  beforeEach(() => setPlatform("ios"));

  it("runs a closing item's action once the surface has had time to go away", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useMenuState({ defaultOpen: true }));

    act(() => result.current.selectItem(onSelect, true));
    expect(result.current.open).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(IOS_TEARDOWN_GRACE_MS));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("leaves the menu open for an item that does not close it", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useMenuState({ defaultOpen: true }));

    act(() => result.current.selectItem(onSelect, false));
    expect(result.current.open).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("useMenuState selectItem elsewhere", () => {
  beforeEach(() => setPlatform("android"));

  it("runs a closing item's action immediately", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useMenuState({ defaultOpen: true }));

    act(() => result.current.selectItem(onSelect, true));
    expect(result.current.open).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

it("forwards the captured click to a menu action", () => {
  setPlatform("web");
  const { result } = renderHook(() => useMenuState({ defaultOpen: true }));
  const click = {
    nativeEvent: { metaKey: true },
    persist: vi.fn(),
  } as unknown as GestureResponderEvent;
  const action = vi.fn();
  act(() => result.current.selectItem(action, true, click));
  expect(action).toHaveBeenCalledWith(click);
});
