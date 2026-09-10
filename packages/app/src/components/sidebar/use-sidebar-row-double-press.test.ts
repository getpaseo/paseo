import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarRowDoublePress } from "./use-sidebar-row-double-press";

let root: Root | null = null;
let container: HTMLElement | null = null;
let latestHandler: { press: () => void } | null = null;
let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;

function Harness({
  onPress,
  onRename,
  didLongPressRef,
}: {
  onPress: () => void;
  onRename?: () => void;
  didLongPressRef?: { current: boolean } | null;
}) {
  const press = useSidebarRowDoublePress({ onPress, onRename, didLongPressRef });
  latestHandler = { press };
  return null;
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  act(() => {
    root?.render(React.createElement(Harness, props));
  });
  return latestHandler as { press: () => void };
}

function pressAt(handler: { press: () => void }, time: number) {
  dateNowSpy?.mockReturnValue(time);
  act(() => {
    handler.press();
  });
}

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
  latestHandler = null;
  dateNowSpy = vi.spyOn(Date, "now");
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  latestHandler = null;
  dateNowSpy?.mockRestore();
  dateNowSpy = null;
  vi.unstubAllGlobals();
});

describe("useSidebarRowDoublePress", () => {
  it("calls onPress for a single press", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    const handler = renderHarness({ onPress, onRename });

    pressAt(handler, 1000);

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("opens rename on a second press inside the window", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    const handler = renderHarness({ onPress, onRename });

    pressAt(handler, 1000);
    pressAt(handler, 1200);

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("treats two presses outside the window as two selections", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    const handler = renderHarness({ onPress, onRename });

    pressAt(handler, 1000);
    pressAt(handler, 1000 + 400);

    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("treats a press right after a rename as a fresh selection", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    const handler = renderHarness({ onPress, onRename });

    pressAt(handler, 1000);
    pressAt(handler, 1100);
    pressAt(handler, 1200);

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("falls through to onPress when rename is unavailable", () => {
    const onPress = vi.fn();
    const handler = renderHarness({ onPress });

    pressAt(handler, 1000);
    pressAt(handler, 1100);

    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("swallows the press after a long press and starts timing over", () => {
    const onPress = vi.fn();
    const onRename = vi.fn();
    const didLongPressRef = { current: false };
    const handler = renderHarness({ onPress, onRename, didLongPressRef });

    pressAt(handler, 1000);
    didLongPressRef.current = true;
    pressAt(handler, 1100);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();

    pressAt(handler, 1200);
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onRename).not.toHaveBeenCalled();
  });
});
