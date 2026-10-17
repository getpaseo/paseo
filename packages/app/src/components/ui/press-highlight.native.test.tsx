// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PointerType,
  State,
  type GestureStateChangeEvent,
  type GestureStateManager,
  type GestureTouchEvent,
  type TapGesture,
  type TapGestureHandlerEventPayload,
} from "react-native-gesture-handler";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PressHighlight } from "./press-highlight.native";

const { detectedGestures, highlightValues } = vi.hoisted(() => ({
  detectedGestures: new Array<TapGesture>(),
  highlightValues: new Array<{ value: number }>(),
}));

// The native gesture runtime does not exist under jsdom. Keep the real gesture builders and
// capture what PressHighlight hands to the detector, so the test drives its callbacks directly.
vi.mock("react-native-gesture-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-gesture-handler")>();
  return {
    ...actual,
    GestureDetector: ({
      gesture,
      children,
    }: {
      gesture: TapGesture;
      children: React.ReactNode;
    }) => {
      detectedGestures.push(gesture);
      return children;
    },
  };
});

vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  const { useState } = await import("react");
  return {
    default: { View },
    useAnimatedStyle: () => ({}),
    useSharedValue: (initial: number) => {
      const [shared] = useState(() => {
        const created = { value: initial };
        highlightValues.push(created);
        return created;
      });
      return shared;
    },
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // react-native-web delays press-in by 50 ms.
  vi.useFakeTimers();
  detectedGestures.length = 0;
  highlightValues.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
    container.remove();
  }
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPressHighlight(props: React.ComponentProps<typeof PressHighlight>) {
  act(() => {
    root?.render(<PressHighlight testID="row" {...props} />);
  });
  const element = container?.querySelector<HTMLElement>('[data-testid="row"]');
  if (!element) {
    throw new Error("PressHighlight did not render its pressable");
  }
  return element;
}

function tapGesture() {
  const gesture = detectedGestures.at(-1);
  if (!gesture) {
    throw new Error("PressHighlight did not attach a gesture");
  }
  return gesture;
}

function highlight() {
  const value = highlightValues.at(-1);
  if (!value) {
    throw new Error("PressHighlight did not create its highlight value");
  }
  return value.value;
}

function touchesDown(pointerType: PointerType) {
  const stateManager = {
    activate: vi.fn<GestureStateManager["activate"]>(),
    begin: vi.fn<GestureStateManager["begin"]>(),
    end: vi.fn<GestureStateManager["end"]>(),
    fail: vi.fn<GestureStateManager["fail"]>(),
  };
  const touch = { id: 0, x: 12, y: 8, absoluteX: 112, absoluteY: 208 };
  // The first touch-down reaches the handler before it begins, so its state is UNDETERMINED.
  const event: GestureTouchEvent = {
    handlerTag: 1,
    numberOfTouches: 1,
    state: State.UNDETERMINED,
    // TouchEventType.TOUCHES_DOWN; the package does not export TouchEventType.
    eventType: 1,
    allTouches: [touch],
    changedTouches: [touch],
    pointerType,
  };
  tapGesture().handlers.onTouchesDown?.(event, stateManager);
  return stateManager;
}

function tapStateChange(
  oldState: State,
  state: State,
): GestureStateChangeEvent<TapGestureHandlerEventPayload> {
  return {
    handlerTag: 1,
    numberOfPointers: 1,
    oldState,
    state,
    pointerType: PointerType.TOUCH,
    x: 12,
    y: 8,
    absoluteX: 112,
    absoluteY: 208,
  };
}

function click(element: HTMLElement) {
  const init = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", init));
    vi.advanceTimersByTime(100);
    element.dispatchEvent(new MouseEvent("mouseup", init));
    element.click();
    vi.advanceTimersByTime(100);
  });
}

const highlightStyle = { backgroundColor: "red" };

describe("PressHighlight (native)", () => {
  it("fails the highlight tap as soon as a mouse touches down", () => {
    renderPressHighlight({ highlightStyle });

    expect(touchesDown(PointerType.MOUSE).fail).toHaveBeenCalledOnce();
  });

  it("leaves the highlight tap running for touch and stylus", () => {
    renderPressHighlight({ highlightStyle });

    for (const pointerType of [PointerType.TOUCH, PointerType.STYLUS]) {
      const stateManager = touchesDown(pointerType);
      expect(stateManager.fail).not.toHaveBeenCalled();
      expect(stateManager.activate).not.toHaveBeenCalled();
      expect(stateManager.end).not.toHaveBeenCalled();
    }
  });

  it("glows from tap begin until the tap finalizes", () => {
    renderPressHighlight({ highlightStyle });
    const gesture = tapGesture();

    expect(gesture.config).toMatchObject({
      enabled: true,
      maxDist: 8,
      shouldCancelWhenOutside: true,
    });
    gesture.handlers.onBegin?.(tapStateChange(State.UNDETERMINED, State.BEGAN));
    expect(highlight()).toBe(1);
    gesture.handlers.onFinalize?.(tapStateChange(State.ACTIVE, State.END), true);
    expect(highlight()).toBe(0);
  });

  it("delivers the press callbacks to the caller", () => {
    const onPress = vi.fn();
    const onPressIn = vi.fn();
    const onPressOut = vi.fn();
    const element = renderPressHighlight({ highlightStyle, onPress, onPressIn, onPressOut });

    click(element);

    expect(onPressIn).toHaveBeenCalledOnce();
    expect(onPressOut).toHaveBeenCalledOnce();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("disables the highlight tap and the press while disabled", () => {
    const onPress = vi.fn();
    const element = renderPressHighlight({ disabled: true, highlightStyle, onPress });

    click(element);

    expect(tapGesture().config.enabled).toBe(false);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("presses without a gesture when no highlight is requested", () => {
    const onPress = vi.fn();
    const element = renderPressHighlight({ onPress });

    click(element);

    expect(detectedGestures).toHaveLength(0);
    expect(onPress).toHaveBeenCalledOnce();
  });
});
