import React from "react";
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pressable, Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipTrigger } from "./tooltip";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModalInternal: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  FadeIn: {},
  FadeOut: {},
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
  },
}));

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

function renderTrigger({
  childDisabled,
  onPress,
}: {
  childDisabled: boolean;
  onPress: () => void;
}): void {
  act(() => {
    root?.render(
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable disabled={childDisabled} onPress={onPress} testID="trigger">
            <Text>Send</Text>
          </Pressable>
        </TooltipTrigger>
      </Tooltip>,
    );
  });
}

function pressTrigger(): void {
  const trigger = container?.querySelector('[data-testid="trigger"]');
  expect(trigger).not.toBeNull();

  act(() => {
    trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function renderTriggerWithPortaledOverlay(onOpenChange: (open: boolean) => void): void {
  const portalHost = document.createElement("div");
  document.body.appendChild(portalHost);

  act(() => {
    root?.render(
      <Tooltip onOpenChange={onOpenChange}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <View testID="trigger">
            <Pressable testID="inner">
              <Text>Opus 5</Text>
            </Pressable>
            {createPortal(
              <button type="button" data-testid="overlay-option">
                Sonnet 5
              </button>,
              portalHost,
            )}
          </View>
        </TooltipTrigger>
      </Tooltip>,
    );
  });
}

function pressKey(): void {
  act(() => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "m", altKey: true }));
  });
}

function focusElement(testID: string): void {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  expect(element).not.toBeNull();

  act(() => {
    element?.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  });
}

describe("TooltipTrigger", () => {
  it("keeps an asChild trigger disabled when the child is disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: true, onPress });
    pressTrigger();

    expect(onPress).not.toHaveBeenCalled();
  });

  it("keeps an asChild trigger interactive when the child is not disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: false, onPress });
    pressTrigger();

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("opens on keyboard focus inside the trigger", () => {
    const onOpenChange = vi.fn();

    renderTriggerWithPortaledOverlay(onOpenChange);
    pressKey();
    focusElement("inner");

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  // A combobox rendered inside its own tooltip trigger portals out of the
  // trigger's DOM subtree but stays a React child, so its focus events still
  // reach these handlers. Opening it by shortcut used to show the tooltip, and
  // the overlay unmounts while focused, so the tooltip never got its blur.
  it("ignores keyboard focus that lands in an overlay portaled out of the trigger", () => {
    const onOpenChange = vi.fn();

    renderTriggerWithPortaledOverlay(onOpenChange);
    pressKey();
    focusElement("overlay-option");

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
