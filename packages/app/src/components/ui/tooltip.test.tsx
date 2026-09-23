import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTooltipAnchorMeasurement, Tooltip, TooltipTrigger } from "./tooltip";

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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("createTooltipAnchorMeasurement", () => {
  it("uses the latest anchor after modal, keyboard, layout, and window geometry changes", async () => {
    const beforeModal = deferred<{ x: number; y: number; width: number; height: number }>();
    const afterKeyboardHide = deferred<{ x: number; y: number; width: number; height: number }>();
    const afterTriggerLayout = deferred<{ x: number; y: number; width: number; height: number }>();
    const afterWindowChange = deferred<{ x: number; y: number; width: number; height: number }>();
    const measure = vi
      .fn<() => Promise<{ x: number; y: number; width: number; height: number }>>()
      .mockReturnValueOnce(beforeModal.promise)
      .mockReturnValueOnce(afterKeyboardHide.promise)
      .mockReturnValueOnce(afterTriggerLayout.promise)
      .mockReturnValueOnce(afterWindowChange.promise);
    const onRect = vi.fn();
    const measurement = createTooltipAnchorMeasurement({ measure, statusBarHeight: 24, onRect });

    measurement.refresh();
    measurement.refresh();
    measurement.refresh();
    measurement.refresh();
    expect(measure).toHaveBeenCalledTimes(4);

    beforeModal.resolve({ x: 180, y: 760, width: 40, height: 40 });
    afterKeyboardHide.resolve({ x: 180, y: 1120, width: 40, height: 40 });
    afterTriggerLayout.resolve({ x: 180, y: 1640, width: 40, height: 40 });
    await Promise.resolve();
    expect(onRect).not.toHaveBeenCalled();

    afterWindowChange.resolve({ x: 180, y: 1780, width: 40, height: 40 });
    await Promise.resolve();
    expect(onRect).toHaveBeenCalledTimes(1);
    expect(onRect).toHaveBeenLastCalledWith({ x: 180, y: 1804, width: 40, height: 40 });
  });

  it("ignores an anchor measurement and retained refresh callback after the tooltip closes", async () => {
    const pending = deferred<{ x: number; y: number; width: number; height: number }>();
    const onRect = vi.fn();
    const measurement = createTooltipAnchorMeasurement({
      measure: () => pending.promise,
      statusBarHeight: 0,
      onRect,
    });

    measurement.refresh();
    measurement.dispose();
    measurement.refresh();
    pending.resolve({ x: 180, y: 760, width: 40, height: 40 });
    await Promise.resolve();

    expect(onRect).not.toHaveBeenCalled();
  });
});
