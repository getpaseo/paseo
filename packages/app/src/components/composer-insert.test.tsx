/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import React, { useCallback, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ComposerInsertProvider, useComposerInsert } from "./composer-insert";

function createWrapper(setText: (text: string) => void) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const [text, internalSetText] = useState("run");
    const apply = useCallback((next: string) => {
      internalSetText(next);
      setText(next);
    }, []);
    return (
      <ComposerInsertProvider text={text} setText={apply}>
        {children}
      </ComposerInsertProvider>
    );
  };
}

describe("ComposerInsertProvider", () => {
  it("appends the command and focuses the registered composer", () => {
    const setText = vi.fn();
    const focus = vi.fn();
    const { result } = renderHook(() => useComposerInsert(), {
      wrapper: createWrapper(setText),
    });

    act(() => {
      result.current?.registerFocusHandler(focus);
      result.current?.insertSlashCommand("/autoplan");
    });

    expect(setText).toHaveBeenCalledWith("run /autoplan ");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no focus handler is registered", () => {
    const setText = vi.fn();
    const { result } = renderHook(() => useComposerInsert(), {
      wrapper: createWrapper(setText),
    });

    act(() => {
      result.current?.insertSlashCommand("/autoplan");
    });

    expect(setText).toHaveBeenCalledWith("run /autoplan ");
  });

  it("stops focusing after the composer unregisters", () => {
    const setText = vi.fn();
    const focus = vi.fn();
    const { result } = renderHook(() => useComposerInsert(), {
      wrapper: createWrapper(setText),
    });

    act(() => {
      result.current?.registerFocusHandler(focus);
      result.current?.registerFocusHandler(null);
      result.current?.insertSlashCommand("/autoplan");
    });

    expect(focus).not.toHaveBeenCalled();
  });
});
