import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

const { theme } = vi.hoisted(() => ({
  theme: {
    opacity: { 50: 0.5 },
    spacing: { 0: 0, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 12, sm: 14, base: 16 },
    borderRadius: { md: 6, lg: 8, xl: 12 },
    borderWidth: { 1: 1 },
    colors: {
      surface3: "#333",
      accent: "#0a84ff",
      accentForeground: "#fff",
      borderAccent: "#555",
      palette: { white: "#fff" },
    },
  },
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  Easing: {
    ease: "ease",
    inOut: (value: unknown) => value,
  },
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[1] : output[0],
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
  withTiming: (value: unknown) => value,
}));

vi.mock("react-native", () => ({
  Platform: {
    select: (values: Record<string, unknown>) => values.web ?? values.default,
  },
  Pressable: ({
    "aria-checked": ariaChecked,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    disabled,
    onKeyDown,
    onPress,
    testID,
  }: {
    "aria-checked"?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean; disabled?: boolean };
    children: React.ReactNode;
    disabled?: boolean;
    onKeyDown?: (event: unknown) => void;
    onPress?: (event: { stopPropagation: () => void }) => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        "aria-checked": ariaChecked ?? accessibilityState?.checked,
        "aria-disabled": accessibilityState?.disabled,
        "aria-label": accessibilityLabel,
        "data-disabled": disabled,
        "data-testid": testID,
        onClick: () => onPress?.({ stopPropagation: vi.fn() }),
        // react-native-web forwards onKeyDown to the DOM node, so the mock does
        // too. This exercises the component's own handler; whether a real
        // browser delivers Space to role="switch" is browser QA's to prove.
        onKeyDown,
        role: accessibilityRole,
        type: "button",
      },
      children,
    ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (
      Component: React.ComponentType<Record<string, unknown>>,
      mapping?: (theme: unknown) => object,
    ) =>
    (props: Record<string, unknown>) =>
      React.createElement(Component, { ...props, ...mapping?.(theme) }),
}));

describe("Switch", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("navigator", dom.window.navigator);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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
  });

  function renderSwitch(props: React.ComponentProps<typeof Switch>): HTMLElement {
    act(() => {
      root?.render(<Switch {...props} />);
    });

    const switchElement = container?.querySelector('[role="switch"]') as HTMLElement | null;
    if (!switchElement) {
      throw new Error("Expected switch element to render");
    }
    return switchElement;
  }

  function pressSwitch(switchElement: HTMLElement): void {
    act(() => {
      switchElement.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  it("renders with accessibility role switch", () => {
    const switchElement = renderSwitch({
      value: false,
      accessibilityLabel: "Enable Claude",
      testID: "provider-switch",
    });

    expect(switchElement.getAttribute("role")).toBe("switch");
    expect(switchElement.getAttribute("aria-label")).toBe("Enable Claude");
  });

  it("calls onValueChange with the toggled value when pressed", () => {
    const onValueChange = vi.fn();
    const switchElement = renderSwitch({ value: false, onValueChange });

    pressSwitch(switchElement);

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it("does not call onValueChange when disabled", () => {
    const onValueChange = vi.fn();
    const switchElement = renderSwitch({ value: false, onValueChange, disabled: true });

    pressSwitch(switchElement);

    expect(onValueChange).not.toHaveBeenCalled();
  });

  function keyDown(switchElement: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
    const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      switchElement.dispatchEvent(event);
    });
    return event;
  }

  it("toggles exactly once on Space, which react-native-web ignores for role switch", () => {
    const onValueChange = vi.fn();
    const switchElement = renderSwitch({ value: false, onValueChange });

    keyDown(switchElement, { code: "Space", key: " " });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it("cancels the Space default so the page does not scroll", () => {
    const switchElement = renderSwitch({ value: false, onValueChange: vi.fn() });

    const event = keyDown(switchElement, { code: "Space", key: " " });

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not toggle on Space when disabled", () => {
    const onValueChange = vi.fn();
    const switchElement = renderSwitch({ value: false, onValueChange, disabled: true });

    keyDown(switchElement, { code: "Space", key: " " });

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("leaves Enter to the press responder so it cannot toggle twice", () => {
    const onValueChange = vi.fn();
    const switchElement = renderSwitch({ value: false, onValueChange });

    // Enter must not reach the Space handler. The press responder already
    // accepts Enter, so handling it here as well would toggle twice.
    keyDown(switchElement, { code: "Enter", key: "Enter" });
    expect(onValueChange).not.toHaveBeenCalled();

    pressSwitch(switchElement);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const onValueChange = vi.fn();
    const switchElement = renderSwitch({ value: false, onValueChange });

    keyDown(switchElement, { code: "KeyA", key: "a" });
    keyDown(switchElement, { code: "Escape", key: "Escape" });

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("reflects checked accessibility state from value", () => {
    const switchElement = renderSwitch({ value: true });

    expect(switchElement.getAttribute("aria-checked")).toBe("true");

    act(() => {
      root?.render(<Switch value={false} />);
    });

    expect(switchElement.getAttribute("aria-checked")).toBe("false");
  });
});
