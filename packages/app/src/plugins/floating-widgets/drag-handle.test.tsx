/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Text } from "react-native";
import { FloatingWidgetDragContext, FloatingWidgetDragHandle } from "./drag-handle";

const targetStyle = { width: 120, height: 120 };
function createDragRuntime() {
  return { begin: vi.fn(), move: vi.fn(), end: vi.fn() };
}

function pointer(
  type: "mouseDown" | "mouseMove" | "mouseUp",
  body: HTMLElement,
  x: number,
  y: number,
) {
  const event = createEvent[type](body, {
    clientX: x,
    clientY: y,
    buttons: type === "mouseUp" ? 0 : 1,
  });
  // JSDOM MouseEvent has no page coordinates, which the RN responder history requires.
  Object.defineProperties(event, { pageX: { value: x }, pageY: { value: y } });
  fireEvent(body, event);
}

function fixture() {
  const drag = createDragRuntime();
  const press = vi.fn();
  const longPress = vi.fn();
  const view = render(
    <FloatingWidgetDragContext.Provider value={drag}>
      <FloatingWidgetDragHandle
        accessibilityLabel="Pet body"
        onPress={press}
        onLongPress={longPress}
        style={targetStyle}
      >
        <Text>Pet</Text>
      </FloatingWidgetDragHandle>
    </FloatingWidgetDragContext.Provider>,
  );
  return {
    ...view,
    drag,
    press,
    longPress,
    body: screen.getByRole("button", { name: "Pet body" }),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps a small pointer wobble a single tap without moving the widget", () => {
  const { body, drag, press, longPress } = fixture();
  pointer("mouseDown", body, 100, 100);
  pointer("mouseMove", body, 103, 101);
  pointer("mouseUp", body, 103, 101);
  fireEvent.click(body, { detail: 1 });
  expect(drag.begin).toHaveBeenCalledOnce();
  expect(drag.move).not.toHaveBeenCalled();
  expect(drag.end).toHaveBeenCalledOnce();
  expect(press).toHaveBeenCalledOnce();
  expect(longPress).not.toHaveBeenCalled();
});

it("moves after the threshold, cancels long-press, and never pats after returning to the start", () => {
  vi.useFakeTimers();
  const { body, drag, press, longPress } = fixture();
  pointer("mouseDown", body, 100, 100);
  act(() => vi.advanceTimersByTime(1));
  pointer("mouseMove", body, 130, 115);
  act(() => vi.advanceTimersByTime(500));
  expect(drag.move).toHaveBeenCalledWith(30, 15);
  act(() => vi.advanceTimersByTime(1));
  pointer("mouseMove", body, 100, 100);
  pointer("mouseUp", body, 100, 100);
  fireEvent.click(body, { detail: 1 });
  expect(drag.end).toHaveBeenCalledOnce();
  expect(press).not.toHaveBeenCalled();
  expect(longPress).not.toHaveBeenCalled();
});

it("fires a stationary long press once and cancels a pending gesture on unmount", () => {
  vi.useFakeTimers();
  const { body, press, longPress, drag, unmount } = fixture();
  pointer("mouseDown", body, 100, 100);
  act(() => vi.advanceTimersByTime(450));
  expect(longPress).toHaveBeenCalledOnce();
  pointer("mouseUp", body, 100, 100);
  fireEvent.click(body, { detail: 1 });
  expect(press).not.toHaveBeenCalled();
  pointer("mouseDown", body, 100, 100);
  unmount();
  act(() => vi.advanceTimersByTime(500));
  expect(longPress).toHaveBeenCalledOnce();
  expect(drag.end).toHaveBeenCalledTimes(2);
});

it("retains semantic button activation without starting a pointer gesture", () => {
  const { body, press, drag } = fixture();
  fireEvent.click(body);
  expect(press).toHaveBeenCalledOnce();
  expect(drag.begin).not.toHaveBeenCalled();
});

it("handles semantic activation, pointer click, and immediate semantic activation exactly once each", () => {
  const { body, press } = fixture();
  fireEvent.click(body, { detail: 0 });
  fireEvent.click(body, { detail: 0 });
  pointer("mouseDown", body, 100, 100);
  pointer("mouseUp", body, 100, 100);
  fireEvent.click(body, { detail: 1 });
  expect(press).toHaveBeenCalledTimes(3);
  fireEvent.click(body, { detail: 0 });
  expect(press).toHaveBeenCalledTimes(4);
});

it("cancels the previous host's pending action when the drag owner changes", () => {
  vi.useFakeTimers();
  const { body, drag, press, longPress, rerender } = fixture();
  pointer("mouseDown", body, 100, 100);
  const replacement = createDragRuntime();
  rerender(
    <FloatingWidgetDragContext.Provider value={replacement}>
      <FloatingWidgetDragHandle
        accessibilityLabel="Pet body"
        onPress={press}
        onLongPress={longPress}
      >
        <Text>Pet</Text>
      </FloatingWidgetDragHandle>
    </FloatingWidgetDragContext.Provider>,
  );
  act(() => vi.advanceTimersByTime(500));
  expect(drag.end).toHaveBeenCalledOnce();
  expect(longPress).not.toHaveBeenCalled();
  pointer("mouseUp", body, 100, 100);
  expect(press).not.toHaveBeenCalled();
});
