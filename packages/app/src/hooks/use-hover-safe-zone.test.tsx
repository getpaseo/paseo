/**
 * @vitest-environment jsdom
 */
import React, { useRef, type RefObject } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHoverSafeZone } from "./use-hover-safe-zone";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
}));

type RectInput = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installRect(node: HTMLDivElement | null, rect: RectInput): void {
  if (!node) return;
  node.getBoundingClientRect = () =>
    ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => rect,
    }) as DOMRect;
}

function Harness({
  onEnterSafeZone,
  onLeaveSafeZone,
}: {
  onEnterSafeZone: () => void;
  onLeaveSafeZone: () => void;
}) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useHoverSafeZone({
    enabled: true,
    triggerRef: triggerRef as unknown as RefObject<View | null>,
    contentRef: contentRef as unknown as RefObject<View | null>,
    onEnterSafeZone,
    onLeaveSafeZone,
  });

  return (
    <>
      <div
        ref={(node) => {
          triggerRef.current = node;
          installRect(node, { left: 0, right: 100, top: 20, bottom: 60 });
        }}
      />
      <div
        ref={(node) => {
          contentRef.current = node;
          installRect(node, { left: 120, right: 240, top: 20, bottom: 120 });
        }}
      />
    </>
  );
}

function pointerMove(x: number, y: number): void {
  document.dispatchEvent(
    new window.MouseEvent("pointermove", {
      bubbles: true,
      clientX: x,
      clientY: y,
    }),
  );
}

describe("useHoverSafeZone", () => {
  it("tracks transitions across trigger, bridge, content, and outside space", () => {
    const onEnterSafeZone = vi.fn();
    const onLeaveSafeZone = vi.fn();

    act(() => {
      root?.render(<Harness onEnterSafeZone={onEnterSafeZone} onLeaveSafeZone={onLeaveSafeZone} />);
    });

    act(() => pointerMove(110, 40));
    expect(onLeaveSafeZone).not.toHaveBeenCalled();

    act(() => pointerMove(300, 40));
    expect(onLeaveSafeZone).toHaveBeenCalledTimes(1);

    act(() => pointerMove(130, 40));
    expect(onEnterSafeZone).toHaveBeenCalledTimes(1);
  });

  it("treats leaving the browser window as leaving the safe zone", () => {
    const onEnterSafeZone = vi.fn();
    const onLeaveSafeZone = vi.fn();

    act(() => {
      root?.render(<Harness onEnterSafeZone={onEnterSafeZone} onLeaveSafeZone={onLeaveSafeZone} />);
    });

    act(() => {
      window.dispatchEvent(new window.MouseEvent("pointerout", { bubbles: true }));
    });
    expect(onLeaveSafeZone).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new window.FocusEvent("blur"));
    });
    expect(onLeaveSafeZone).toHaveBeenCalledTimes(1);
  });
});
