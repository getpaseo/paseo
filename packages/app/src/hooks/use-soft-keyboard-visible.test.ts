// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSoftKeyboardVisible } from "@/hooks/use-soft-keyboard-visible";

function installPointerMediaQuery(initialCoarse: boolean) {
  let coarse = initialCoarse;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return coarse;
    },
    media: "(pointer: coarse)",
    addEventListener: (_type: "change", listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "change", listener: () => void) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    setCoarse(next: boolean) {
      coarse = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSoftKeyboardVisible (web)", () => {
  it("is true on a coarse-pointer (touch) device", () => {
    installPointerMediaQuery(true);
    const { result } = renderHook(() => useSoftKeyboardVisible());
    expect(result.current).toBe(true);
  });

  it("is false on a fine-pointer (mouse/trackpad) device", () => {
    installPointerMediaQuery(false);
    const { result } = renderHook(() => useSoftKeyboardVisible());
    expect(result.current).toBe(false);
  });

  it("reacts when the primary pointer changes to coarse", () => {
    const pointer = installPointerMediaQuery(false);
    const { result } = renderHook(() => useSoftKeyboardVisible());
    expect(result.current).toBe(false);

    act(() => {
      pointer.setCoarse(true);
    });

    expect(result.current).toBe(true);
  });
});
