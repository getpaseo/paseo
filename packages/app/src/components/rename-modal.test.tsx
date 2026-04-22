import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenameModal } from "./rename-modal";

const { theme, adaptiveInputState } = vi.hoisted(() => ({
  adaptiveInputState: {
    latestProps: null as {
      onChangeText?: (next: string) => void;
      onSubmitEditing?: () => void;
    } | null,
  },
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    iconSize: { sm: 14, md: 18 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500" },
    borderRadius: { md: 6, lg: 8, xl: 12, full: 999 },
    opacity: { 50: 0.5 },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      borderAccent: "#444",
      accent: "#0a84ff",
      accentForeground: "#fff",
      destructive: "#ff453a",
      popoverForeground: "#fff",
      palette: {
        white: "#fff",
        red: { 300: "#f87171" },
      },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  const AdaptiveModalSheet = ({
    visible,
    title,
    children,
    onClose,
    testID,
  }: {
    visible: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
    testID?: string;
  }) => {
    ReactModule.useEffect(() => {
      if (!visible) return;
      const handler = (event: KeyboardEvent) => {
        if (event.key === "Escape") onClose();
      };
      document.addEventListener("keydown", handler);
      return () => document.removeEventListener("keydown", handler);
    }, [visible, onClose]);
    if (!visible) return null;
    return ReactModule.createElement(
      "div",
      { "data-testid": testID ?? "adaptive-modal-sheet", "data-modal-title": title },
      ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": "adaptive-modal-sheet-close",
          onClick: onClose,
        },
        "Close",
      ),
      children,
    );
  };
  const AdaptiveTextInput = ReactModule.forwardRef<HTMLInputElement, Record<string, unknown>>(
    (props, ref) => {
      const { value, placeholder, editable, maxLength, testID, onChangeText, onSubmitEditing } =
        props as {
          value?: string;
          placeholder?: string;
          editable?: boolean;
          maxLength?: number;
          testID?: string;
          onChangeText?: (next: string) => void;
          onSubmitEditing?: () => void;
        };
      adaptiveInputState.latestProps = { onChangeText, onSubmitEditing };
      return ReactModule.createElement("input", {
        ref,
        value: value ?? "",
        placeholder,
        disabled: editable === false,
        maxLength,
        "data-testid": testID,
        onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
        onKeyDown: (event: { key: string; preventDefault: () => void }) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmitEditing?.();
          }
        },
      });
    },
  );
  return { AdaptiveModalSheet, AdaptiveTextInput };
});

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      disabled,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": testID,
          disabled: disabled === true ? true : undefined,
          onClick: () => {
            if (disabled) return;
            onPress?.();
          },
        },
        children,
      ),
  };
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
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  adaptiveInputState.latestProps = null;
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

type RenderOptions = {
  visible?: boolean;
  initialValue?: string;
  title?: string;
  placeholder?: string;
  submitLabel?: string;
  onClose?: () => void;
  onSubmit?: (value: string) => Promise<void> | void;
  validate?: (value: string) => string | null;
  transform?: (value: string) => string;
  maxLength?: number;
};

function renderModal(options: RenderOptions = {}): void {
  const {
    visible = true,
    initialValue = "",
    title = "Rename",
    placeholder,
    submitLabel,
    onClose = vi.fn(),
    onSubmit = vi.fn(),
    validate,
    transform,
    maxLength,
  } = options;
  act(() => {
    root?.render(
      <RenameModal
        visible={visible}
        title={title}
        initialValue={initialValue}
        placeholder={placeholder}
        submitLabel={submitLabel}
        onClose={onClose}
        onSubmit={onSubmit}
        validate={validate}
        transform={transform}
        maxLength={maxLength}
        testID="rename-modal"
      />,
    );
  });
}

function queryInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-testid="rename-modal-input"]');
}

function querySubmit(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-testid="rename-modal-submit"]');
}

function queryCancel(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-testid="rename-modal-cancel"]');
}

function queryError(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="rename-modal-error"]');
}

function click(element: Element | null): void {
  if (!element) throw new Error("Cannot click null element");
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(value: string): void {
  act(() => {
    adaptiveInputState.latestProps?.onChangeText?.(value);
  });
}

function pressEnter(): void {
  act(() => {
    adaptiveInputState.latestProps?.onSubmitEditing?.();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RenameModal", () => {
  it("renders with the initial value pre-filled and selects it after open", async () => {
    vi.useFakeTimers();
    renderModal({ initialValue: "main" });
    const input = queryInput();
    expect(input).not.toBeNull();
    expect(input?.value).toBe("main");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const focused = document.activeElement as HTMLInputElement | null;
    expect(focused).toBe(input);
    expect(focused?.selectionStart).toBe(0);
    expect(focused?.selectionEnd).toBe("main".length);
  });

  it("submits on Enter keypress in the input when the value has changed", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    renderModal({ initialValue: "feature", onSubmit, onClose });

    typeInto("feature-2");
    pressEnter();
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("feature-2");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when AdaptiveModalSheet's close prop fires (cancel button / backdrop delegated)", () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderModal({ initialValue: "main", onClose, onSubmit });

    click(document.querySelector('[data-testid="adaptive-modal-sheet-close"]'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onClose when the real Escape keydown fires (routed by AdaptiveModalSheet)", () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderModal({ initialValue: "main", onClose, onSubmit });

    act(() => {
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables submit when draft equals initialValue and re-enables after a change", async () => {
    const onSubmit = vi.fn();
    renderModal({ initialValue: "main", onSubmit });

    expect(querySubmit()?.disabled).toBe(true);

    pressEnter();
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();

    typeInto("main-v2");
    await flush();
    expect(querySubmit()?.disabled).toBe(false);

    typeInto("main");
    await flush();
    expect(querySubmit()?.disabled).toBe(true);
  });

  it("surfaces validate errors inline and blocks submission", async () => {
    const onSubmit = vi.fn();
    const validate = vi.fn((value: string) => (value === "bad" ? "Invalid name" : null));
    renderModal({ initialValue: "ok", validate, onSubmit });

    typeInto("bad");
    const submit = querySubmit()!;
    expect(submit.disabled).toBe(true);

    pressEnter();
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
    const errorNode = queryError();
    expect(errorNode?.textContent).toContain("Invalid name");
  });

  it("applies the transform live and passes the transformed value to onSubmit", async () => {
    const onSubmit = vi.fn();
    const transform = (value: string) => value.toLowerCase().replace(/\s+/g, "-");
    renderModal({ initialValue: "", transform, onSubmit });

    typeInto("Foo Bar");
    await flush();
    expect(queryInput()?.value).toBe("foo-bar");

    click(querySubmit());
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("foo-bar");
  });

  it("disables the submit button while onSubmit is pending", async () => {
    let resolve: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    renderModal({ initialValue: "main", onSubmit });

    typeInto("main-renamed");
    click(querySubmit());
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(querySubmit()?.disabled).toBe(true);
    expect(queryCancel()?.disabled).toBe(true);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
  });

  it("keeps the modal open with an error when onSubmit rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Server said no"));
    const onClose = vi.fn();
    renderModal({ initialValue: "main", onSubmit, onClose });

    typeInto("main-renamed");
    click(querySubmit());
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    expect(queryError()?.textContent).toContain("Server said no");
    expect(querySubmit()?.disabled).toBe(false);
  });
});
