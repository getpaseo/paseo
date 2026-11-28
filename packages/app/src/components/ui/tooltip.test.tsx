import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot, MenuTrigger } from "./menu/menu-root";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

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
    View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement("div", { "data-testid": testID }, children),
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
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

  it("closes when an asChild MenuTrigger is pressed", async () => {
    const onMenuOpenChange = vi.fn();

    act(() => {
      root?.render(
        <MenuRoot onOpenChange={onMenuOpenChange}>
          <Tooltip enabledOnMobile={false}>
            <TooltipTrigger asChild>
              <MenuTrigger testID="trigger" accessibilityLabel="Agent steps">
                <Text>Standard</Text>
              </MenuTrigger>
            </TooltipTrigger>
            <TooltipContent testID="tooltip-content">
              <Text>Agent steps</Text>
            </TooltipContent>
          </Tooltip>
        </MenuRoot>,
      );
    });

    const trigger = container?.querySelector('[data-testid="trigger"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="tooltip-content"]')).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
    expect(document.querySelector('[data-testid="tooltip-content"]')).toBeNull();
  });

  it("stays closed after being disabled while open and re-enabled", async () => {
    const renderControlled = async (enabledOnDesktop: boolean) => {
      await act(async () => {
        root?.render(
          <Tooltip enabledOnDesktop={enabledOnDesktop} enabledOnMobile={false}>
            <TooltipTrigger asChild>
              <Pressable testID="trigger">
                <Text>Standard</Text>
              </Pressable>
            </TooltipTrigger>
            <TooltipContent testID="tooltip-content">
              <Text>Agent steps</Text>
            </TooltipContent>
          </Tooltip>,
        );
        await Promise.resolve();
      });
    };

    await renderControlled(true);

    const trigger = container?.querySelector('[data-testid="trigger"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="tooltip-content"]')).not.toBeNull();

    await renderControlled(false);
    expect(document.querySelector('[data-testid="tooltip-content"]')).toBeNull();

    await renderControlled(true);
    expect(document.querySelector('[data-testid="tooltip-content"]')).toBeNull();
  });
});
