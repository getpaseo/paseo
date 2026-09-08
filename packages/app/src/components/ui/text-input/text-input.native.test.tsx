// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomSheetScope } from "@/components/ui/bottom-sheet-scope";
import { EditingTextInput } from "./text-input.native";
import type { EditingTextInputHandle } from "./types";

const bottomSheetTextInputRender = vi.hoisted(() => vi.fn());

vi.mock("@gorhom/bottom-sheet", async () => {
  const ReactModule = await import("react");
  return {
    BottomSheetTextInput: ReactModule.forwardRef<HTMLInputElement, Record<string, unknown>>(
      (props, ref) => {
        bottomSheetTextInputRender(props);
        return ReactModule.createElement("input", {
          ...props,
          ref,
          "data-bottom-sheet-input": true,
        });
      },
    ),
  };
});

vi.mock("@mattermost/react-native-paste-input", async () => {
  const ReactModule = await import("react");
  return {
    default: ReactModule.forwardRef<HTMLInputElement, Record<string, unknown>>((props, ref) =>
      ReactModule.createElement("input", { ...props, ref }),
    ),
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  bottomSheetTextInputRender.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
    container.remove();
  }
  root = null;
  container = null;
});

function noop() {}

describe("EditingTextInputNative", () => {
  it("uses the bottom-sheet input only inside a bottom sheet", () => {
    act(() => {
      root?.render(
        <>
          <EditingTextInput testID="outside" />
          <BottomSheetScope>
            <EditingTextInput testID="inside" />
          </BottomSheetScope>
        </>,
      );
    });

    expect(
      container?.querySelector('[data-testid="outside"]')?.getAttribute("data-bottom-sheet-input"),
    ).toBeNull();
    expect(bottomSheetTextInputRender).toHaveBeenCalledOnce();
    expect(bottomSheetTextInputRender.mock.calls[0]?.[0]).toMatchObject({ testID: "inside" });
  });

  it("clears text via clear() when replaceText receives an empty string", () => {
    const handleRef = createRef<EditingTextInputHandle>();

    act(() => {
      root?.render(<EditingTextInput ref={handleRef} initialValue="initial" onChangeText={noop} />);
    });

    expect(handleRef.current?.getText()).toBe("initial");

    act(() => {
      handleRef.current?.replaceText("");
    });

    expect(handleRef.current?.getText()).toBe("");
  });

  it("replaces the native input when resetting the editor", () => {
    const handleRef = createRef<EditingTextInputHandle>();

    act(() => {
      root?.render(
        <EditingTextInput
          ref={handleRef}
          initialValue="line one\nline two\nline three"
          onChangeText={noop}
        />,
      );
    });
    const grownInput = container?.querySelector("input");

    act(() => {
      handleRef.current?.reset();
    });

    expect(container?.querySelector("input")).not.toBe(grownInput);
  });

  it("restores focus after replacing a reset native input", () => {
    const handleRef = createRef<EditingTextInputHandle>();

    act(() => {
      root?.render(<EditingTextInput ref={handleRef} initialValue="message" />);
    });
    const originalInput = container?.querySelector("input");
    if (!originalInput) throw new Error("Expected native input");
    Object.assign(originalInput, { isFocused: () => true });
    originalInput.focus();

    act(() => {
      handleRef.current?.reset();
    });

    expect(document.activeElement).toBe(container?.querySelector("input"));
  });

  it("focuses the replacement input when focus is requested before an editor reset remounts", () => {
    const handleRef = createRef<EditingTextInputHandle>();

    act(() => {
      root?.render(<EditingTextInput ref={handleRef} initialValue="stale" />);
    });
    const originalInput = container?.querySelector("input");
    if (!originalInput) throw new Error("Expected native input");
    const originalFocus = vi.spyOn(originalInput, "focus");

    act(() => {
      handleRef.current?.reset();
      handleRef.current?.focus();
    });

    const replacementInput = container?.querySelector("input");
    expect(replacementInput).not.toBe(originalInput);
    expect(originalFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(replacementInput);
  });

  it("drops a pending focus restore when blur is requested before an editor reset remounts", () => {
    const handleRef = createRef<EditingTextInputHandle>();

    act(() => {
      root?.render(<EditingTextInput ref={handleRef} initialValue="stale" />);
    });
    const originalInput = container?.querySelector("input");
    if (!originalInput) throw new Error("Expected native input");
    Object.assign(originalInput, { isFocused: () => true });
    originalInput.focus();

    act(() => {
      handleRef.current?.reset();
      handleRef.current?.blur();
    });

    expect(document.activeElement).not.toBe(container?.querySelector("input"));
  });

  it("updates textRef and text when replaceText receives non-empty text", () => {
    const handleRef = createRef<EditingTextInputHandle>();

    act(() => {
      root?.render(<EditingTextInput ref={handleRef} initialValue="hello" />);
    });

    expect(handleRef.current?.getText()).toBe("hello");

    act(() => {
      handleRef.current?.replaceText("world", { start: 0, end: 5 });
    });

    expect(handleRef.current?.getText()).toBe("world");
  });
});
