/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIosHardwareKeyboardSubmit } from "./use-ios-hardware-keyboard-submit";
import {
  emitHardwareKeyboardSubmitForTest,
  resetHardwareKeyboardSubmitForTest,
  getHardwareKeyboardSubmitEnabledForTest,
  setHardwareKeyboardSubmitEnabled,
} from "@/native/ios-hardware-keyboard-submit";

describe("useIosHardwareKeyboardSubmit", () => {
  beforeEach(() => {
    resetHardwareKeyboardSubmitForTest();
  });

  it("submits when the focused composer receives a hardware keyboard submit event", () => {
    const onSubmit = vi.fn();

    renderHook(() =>
      useIosHardwareKeyboardSubmit({
        isEnabled: true,
        onSubmit,
      }),
    );

    act(() => {
      emitHardwareKeyboardSubmitForTest();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit when the composer is blurred", () => {
    const onSubmit = vi.fn();

    renderHook(() =>
      useIosHardwareKeyboardSubmit({
        isEnabled: false,
        onSubmit,
      }),
    );

    act(() => {
      emitHardwareKeyboardSubmitForTest();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(getHardwareKeyboardSubmitEnabledForTest()).toBe(false);
  });

  it("does not submit while the default send action is disabled", () => {
    const onSubmit = vi.fn();

    renderHook(() =>
      useIosHardwareKeyboardSubmit({
        isEnabled: false,
        onSubmit,
      }),
    );

    act(() => {
      emitHardwareKeyboardSubmitForTest();
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not disable native hardware submit when mounted disabled", () => {
    setHardwareKeyboardSubmitEnabled(true);

    renderHook(() =>
      useIosHardwareKeyboardSubmit({
        isEnabled: false,
        onSubmit: vi.fn(),
      }),
    );

    expect(getHardwareKeyboardSubmitEnabledForTest()).toBe(true);
  });

  it("disables native hardware submit when focus moves away", () => {
    const onSubmit = vi.fn();
    const { rerender } = renderHook(
      ({ isEnabled }) =>
        useIosHardwareKeyboardSubmit({
          isEnabled,
          onSubmit,
        }),
      { initialProps: { isEnabled: true } },
    );

    expect(getHardwareKeyboardSubmitEnabledForTest()).toBe(true);

    rerender({ isEnabled: false });

    expect(getHardwareKeyboardSubmitEnabledForTest()).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    const onSubmit = vi.fn();
    const { unmount } = renderHook(() =>
      useIosHardwareKeyboardSubmit({
        isEnabled: true,
        onSubmit,
      }),
    );

    unmount();

    act(() => {
      emitHardwareKeyboardSubmitForTest();
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
