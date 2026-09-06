import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineRenameInput, useDoubleClick } from "./inline-rename-input";
import { renderHook } from "@testing-library/react";

const { theme, editingInputState } = vi.hoisted(() => ({
  editingInputState: {
    latestProps: null as {
      onChangeText?: (next: string) => void;
      onSubmitEditing?: () => void;
      onBlur?: () => void;
      onKeyPress?: (event: { nativeEvent: { key: string }; preventDefault: () => void }) => void;
    } | null,
    currentValue: "",
  },
  theme: {
    spacing: { 0.5: 2, 1: 4, 2: 8 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    borderRadius: { sm: 4, md: 6 },
    colors: {
      surface0: "#000",
      surface2: "#222",
      borderAccent: "#444",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      palette: { red: { 300: "#f87171" } },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (Component: unknown) => Component,
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: ({ size }: { size?: number }) =>
    React.createElement("div", { "data-testid": "loading-spinner", "data-size": size }),
}));

vi.mock("@/components/ui/text-input", () => {
  const ReactModule = React;
  const EditingTextInput = ReactModule.forwardRef<
    {
      focus: () => void;
      getText: () => string;
      replaceText: (text: string, selection?: { start: number; end: number }) => void;
    },
    Record<string, unknown>
  >((props, ref) => {
    const p = props as {
      initialValue?: string;
      editable?: boolean;
      maxLength?: number;
      testID?: string;
      accessibilityLabel?: string;
      onChangeText?: (next: string) => void;
      onSubmitEditing?: () => void;
      onBlur?: () => void;
      onKeyPress?: (event: { nativeEvent: { key: string }; preventDefault: () => void }) => void;
    };

    editingInputState.latestProps = {
      onChangeText: p.onChangeText,
      onSubmitEditing: p.onSubmitEditing,
      onBlur: p.onBlur,
      onKeyPress: p.onKeyPress,
    };

    ReactModule.useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      getText: () => editingInputState.currentValue,
      replaceText: (nextText: string) => {
        editingInputState.currentValue = nextText;
      },
    }));

    return ReactModule.createElement("input", {
      ref: ref as unknown as React.Ref<HTMLInputElement>,
      defaultValue: p.initialValue ?? "",
      disabled: p.editable === false,
      maxLength: p.maxLength,
      "data-testid": p.testID ?? "inline-rename-input",
      "aria-label": p.accessibilityLabel,
      onChange: (e: { target: { value: string } }) => {
        editingInputState.currentValue = e.target.value;
        p.onChangeText?.(e.target.value);
      },
      onBlur: () => p.onBlur?.(),
      onKeyDown: (e: { key: string; preventDefault: () => void }) => {
        p.onKeyPress?.({ nativeEvent: { key: e.key }, preventDefault: e.preventDefault });
        if (e.key === "Enter") {
          e.preventDefault();
          p.onSubmitEditing?.();
        }
      },
    });
  });

  return { EditingTextInput };
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  editingInputState.latestProps = null;
  editingInputState.currentValue = "";
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface RenderProps {
  initialValue: string;
  onSubmit?: (value: string) => Promise<void> | void;
  onCancel?: () => void;
  testID?: string;
}

function renderComponent(options: RenderProps): void {
  const { initialValue, onSubmit = vi.fn(), onCancel = vi.fn(), testID = "inline-input" } = options;
  editingInputState.currentValue = initialValue;
  act(() => {
    root?.render(
      <InlineRenameInput
        initialValue={initialValue}
        onSubmit={onSubmit}
        onCancel={onCancel}
        testID={testID}
      />,
    );
  });
}

function queryInput(testID = "inline-input"): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`[data-testid="${testID}"]`);
}

function queryError(testID = "inline-input"): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testID}-error"]`);
}

function querySpinner(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="loading-spinner"]');
}

function typeInto(value: string): void {
  act(() => {
    editingInputState.currentValue = value;
    editingInputState.latestProps?.onChangeText?.(value);
  });
}

function pressEnter(): void {
  act(() => {
    editingInputState.latestProps?.onSubmitEditing?.();
  });
}

function pressEscape(): void {
  act(() => {
    editingInputState.latestProps?.onKeyPress?.({
      nativeEvent: { key: "Escape" },
      preventDefault: vi.fn(),
    });
  });
}

function blurInput(): void {
  act(() => {
    editingInputState.latestProps?.onBlur?.();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("InlineRenameInput", () => {
  it("renders with initialValue", () => {
    renderComponent({ initialValue: "my-project" });
    const input = queryInput();
    expect(input).not.toBeNull();
    expect(input?.defaultValue).toBe("my-project");
  });

  it("submits on Enter keypress when value has changed", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderComponent({ initialValue: "initial-name", onSubmit, onCancel });

    typeInto("new-name");
    pressEnter();
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("new-name");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape keypress without calling onSubmit", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderComponent({ initialValue: "initial-name", onSubmit, onCancel });

    typeInto("typed-something");
    pressEscape();
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels smoothly on Blur when input is empty without trapping user in error state", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderComponent({ initialValue: "initial-name", onSubmit, onCancel });

    typeInto("   ");
    blurInput();
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(queryError()).toBeNull();
  });

  it("cancels on Blur when input value is unchanged", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderComponent({ initialValue: "initial-name", onSubmit, onCancel });

    blurInput();
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows error and blocks submit when pressing Enter with empty value", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderComponent({ initialValue: "initial-name", onSubmit, onCancel });

    typeInto("   ");
    pressEnter();
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    const errorNode = queryError();
    expect(errorNode).not.toBeNull();
  });

  it("displays loading spinner and disables input while onSubmit is pending", async () => {
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    renderComponent({ initialValue: "old-name", onSubmit });

    typeInto("new-name");
    pressEnter();
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(querySpinner()).not.toBeNull();
    expect(queryInput()?.disabled).toBe(true);

    await act(async () => {
      resolveSubmit();
      await Promise.resolve();
    });
  });

  it("keeps input open with error message when onSubmit rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("RPC failed"));
    const onCancel = vi.fn();
    renderComponent({ initialValue: "old-name", onSubmit, onCancel });

    typeInto("new-name");
    pressEnter();
    await flush();

    expect(onCancel).not.toHaveBeenCalled();
    expect(queryError()?.textContent).toContain("RPC failed");
    expect(queryInput()?.disabled).toBe(false);
  });
});

describe("useDoubleClick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls callback when clicked twice within 300ms", () => {
    const onDoubleClick = vi.fn();
    const { result } = renderHook(() => useDoubleClick(onDoubleClick));

    result.current({ button: 0 });
    vi.advanceTimersByTime(150);
    result.current({ button: 0 });

    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("does not call callback if interval exceeds 300ms", () => {
    const onDoubleClick = vi.fn();
    const { result } = renderHook(() => useDoubleClick(onDoubleClick));

    result.current({ button: 0 });
    vi.advanceTimersByTime(350);
    result.current({ button: 0 });

    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("ignores non-primary mouse buttons (right click, middle click)", () => {
    const onDoubleClick = vi.fn();
    const { result } = renderHook(() => useDoubleClick(onDoubleClick));

    // Right click (button = 2)
    result.current({ button: 2 });
    vi.advanceTimersByTime(100);
    result.current({ button: 2 });

    expect(onDoubleClick).not.toHaveBeenCalled();

    // Middle click (button = 1)
    result.current({ button: 1 });
    vi.advanceTimersByTime(100);
    result.current({ button: 1 });

    expect(onDoubleClick).not.toHaveBeenCalled();
  });
});
