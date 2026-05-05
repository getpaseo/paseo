import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

const { theme } = vi.hoisted(() => ({
  theme: {
    opacity: { 50: 0.5 },
    colors: {
      surface3: "#333",
      accent: "#0a84ff",
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
  Pressable: ({
    "aria-checked": ariaChecked,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    disabled,
    onPress,
    testID,
  }: {
    "aria-checked"?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean; disabled?: boolean };
    children: React.ReactNode;
    disabled?: boolean;
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
  useUnistyles: () => ({ theme }),
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

  it("reflects checked accessibility state from value", () => {
    const switchElement = renderSwitch({ value: true });

    expect(switchElement.getAttribute("aria-checked")).toBe("true");

    act(() => {
      root?.render(<Switch value={false} />);
    });

    expect(switchElement.getAttribute("aria-checked")).toBe("false");
  });
});
