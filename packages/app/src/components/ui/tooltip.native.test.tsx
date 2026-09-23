import React, { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const dimensions: Array<() => void> = [];
  const keyboard = new Map<string, Array<() => void>>();
  return {
    dimensions,
    keyboard,
    modalOnShow: null as (() => void) | null,
    reset() {
      dimensions.splice(0);
      keyboard.clear();
      this.modalOnShow = null;
    },
  };
});

vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => true }));
vi.mock("@/components/ui/floating", async () => {
  const ReactModule = await import("react");
  return {
    FloatingSurface: ({
      children,
      testID,
      frameStyle,
      onLayout,
    }: {
      children: React.ReactNode;
      testID?: string;
      frameStyle?: Array<{ top?: number; left?: number }>;
      onLayout?: (event: unknown) => void;
    }) => {
      ReactModule.useEffect(
        () => onLayout?.({ nativeEvent: { layout: { width: 160, height: 100 } } }),
        [onLayout],
      );
      const frame = Object.assign({}, ...(frameStyle ?? []));
      return ReactModule.createElement(
        "div",
        { "data-testid": testID, "data-top": frame.top, "data-left": frame.left },
        children,
      );
    },
  };
});
vi.mock("@/lib/overlay-root", () => ({
  getOverlayRoot: () => document.body,
  OVERLAY_Z: { tooltip: 1 },
}));
vi.mock("react-native-reanimated", () => ({
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: (theme: Record<string, unknown>) => unknown) =>
      styles({
        spacing: [0, 4, 8],
        borderRadius: { xl: 8 },
        colors: { popover: "white", borderAccent: "black" },
        borderWidth: [0, 1],
        shadow: { md: {} },
      }),
  },
}));
vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
      ReactModule.createElement("div", props as React.HTMLAttributes<HTMLDivElement>, children),
    Pressable: ({
      children,
      onLayout,
      testID,
      ...props
    }: Record<string, unknown> & { children?: React.ReactNode }) =>
      ReactModule.createElement(
        "button",
        {
          ...(props as React.ButtonHTMLAttributes<HTMLButtonElement>),
          type: "button",
          "data-testid": testID,
          onClick: onLayout as React.MouseEventHandler<HTMLButtonElement> | undefined,
        },
        children,
      ),
    Modal: ({ children, onShow }: { children: React.ReactNode; onShow?: () => void }) => {
      bridge.modalOnShow = onShow ?? null;
      return children;
    },
    Dimensions: {
      get: () => ({ width: 390, height: 2048 }),
      addEventListener: (_event: string, callback: () => void) => {
        bridge.dimensions.push(callback);
        return { remove: () => bridge.dimensions.splice(bridge.dimensions.indexOf(callback), 1) };
      },
    },
    Keyboard: {
      addListener: (event: string, callback: () => void) => {
        const callbacks = bridge.keyboard.get(event) ?? [];
        callbacks.push(callback);
        bridge.keyboard.set(event, callbacks);
        return { remove: () => callbacks.splice(callbacks.indexOf(callback), 1) };
      },
    },
    Platform: { OS: "ios" },
    StatusBar: { currentHeight: 0 },
  };
});

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Anchor {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}
const measurements: Array<(rect: Rect) => void> = [];
const NativeAnchor = forwardRef<Anchor, { onLayout?: (event: unknown) => void }>(
  function NativeAnchor({ onLayout }, ref) {
    useImperativeHandle(ref, () => ({
      measureInWindow: (callback) =>
        measurements.push((rect) => callback(rect.x, rect.y, rect.width, rect.height)),
    }));
    const handleLayout = useCallback(() => onLayout?.({}), [onLayout]);
    return (
      <button type="button" data-testid="anchor" onClick={handleLayout}>
        Anchor
      </button>
    );
  },
);

function TooltipFixture({
  open = true,
  onAnchorLayout,
}: {
  open?: boolean;
  onAnchorLayout?: (event: unknown) => void;
}) {
  return (
    <Tooltip open={open} enabledOnMobile>
      <TooltipTrigger asChild>
        <NativeAnchor onLayout={onAnchorLayout} />
      </TooltipTrigger>
      <TooltipContent testID="tooltip-frame" side="top">
        Usage
      </TooltipContent>
    </Tooltip>
  );
}

function ToggleFixture() {
  const [open, setOpen] = useState(true);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <>
      <button type="button" data-testid="toggle" onClick={toggle}>
        Toggle
      </button>
      <TooltipFixture open={open} />
    </>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  bridge.reset();
  measurements.splice(0);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function frameTop(): string | null {
  return (
    container?.querySelector('[data-testid="tooltip-frame"]')?.getAttribute("data-top") ?? null
  );
}

describe("native TooltipContent anchor lifecycle", () => {
  it("moves the visible popup with its anchor when the keyboard finishes hiding", async () => {
    act(() => root?.render(<TooltipFixture />));
    await act(async () => {
      measurements[0]?.({ x: 180, y: 950, width: 40, height: 40 });
      await Promise.resolve();
    });
    expect(frameTop()).toBe("844");

    act(() => bridge.keyboard.get("keyboardDidHide")?.[0]?.());
    await act(async () => {
      measurements[1]?.({ x: 180, y: 1880, width: 40, height: 40 });
      await Promise.resolve();
    });
    expect(frameTop()).toBe("1774");
  });

  it("preserves a non-asChild trigger layout handler", () => {
    const onLayout = vi.fn();
    act(() =>
      root?.render(
        <Tooltip enabledOnMobile>
          <TooltipTrigger testID="direct-trigger" onLayout={onLayout}>
            Anchor
          </TooltipTrigger>
        </Tooltip>,
      ),
    );

    act(() =>
      container
        ?.querySelector('[data-testid="direct-trigger"]')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    );
    expect(onLayout).toHaveBeenCalledTimes(1);
  });

  it("uses the latest anchor from Modal, keyboard, layout, and Dimensions callbacks", async () => {
    const onAnchorLayout = vi.fn();
    act(() => root?.render(<TooltipFixture onAnchorLayout={onAnchorLayout} />));
    expect(bridge.modalOnShow).not.toBeNull();
    expect(bridge.keyboard.get("keyboardDidShow")).toHaveLength(1);
    expect(bridge.keyboard.get("keyboardDidHide")).toHaveLength(1);
    expect(bridge.dimensions).toHaveLength(1);
    expect(measurements).toHaveLength(1);

    act(() => {
      bridge.modalOnShow?.();
      bridge.keyboard.get("keyboardDidHide")?.[0]?.();
      bridge.dimensions[0]?.();
      container
        ?.querySelector('[data-testid="anchor"]')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(onAnchorLayout).toHaveBeenCalledTimes(1);
    expect(measurements).toHaveLength(5);

    await act(async () => {
      measurements[0]?.({ x: 180, y: 950, width: 40, height: 40 });
      measurements[1]?.({ x: 180, y: 1120, width: 40, height: 40 });
      measurements[2]?.({ x: 180, y: 1500, width: 40, height: 40 });
      measurements[3]?.({ x: 180, y: 1640, width: 40, height: 40 });
      await Promise.resolve();
    });
    expect(frameTop()).toBe("-9999");

    await act(async () => {
      measurements[4]?.({ x: 180, y: 1880, width: 40, height: 40 });
      await Promise.resolve();
    });
    expect(frameTop()).toBe("1774");
  });

  it("rejects saved listeners and measurements after closing and reopening", async () => {
    act(() => root?.render(<ToggleFixture />));
    const savedDimensionListener = bridge.dimensions[0];
    const pendingMeasurement = measurements[0];
    act(() =>
      container
        ?.querySelector('[data-testid="toggle"]')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    );
    act(() => savedDimensionListener?.());
    expect(measurements).toHaveLength(1);
    act(() =>
      container
        ?.querySelector('[data-testid="toggle"]')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    );
    expect(measurements).toHaveLength(2);

    await act(async () => {
      pendingMeasurement?.({ x: 180, y: 950, width: 40, height: 40 });
      await Promise.resolve();
    });
    expect(frameTop()).toBe("-9999");
    await act(async () => {
      measurements[1]?.({ x: 180, y: 1880, width: 40, height: 40 });
      await Promise.resolve();
    });
    expect(frameTop()).toBe("1774");
  });
});
