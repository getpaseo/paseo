/**
 * @vitest-environment jsdom
 */
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("react-native-reanimated", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");

  function flattenStyle(style: unknown): Record<string, unknown> {
    if (style == null) {
      return {};
    }
    if (Array.isArray(style)) {
      return Object.assign({}, ...style.map(flattenStyle));
    }
    if (typeof style === "object") {
      return style as Record<string, unknown>;
    }
    return {};
  }

  const View = ReactModule.forwardRef(function MockAnimatedView(
    {
      children,
      style,
      testID,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
    },
    ref: React.Ref<HTMLDivElement>,
  ) {
    const opacity = flattenStyle(style).opacity;
    return ReactModule.createElement(
      "div",
      {
        "data-testid": testID,
        ref,
        style: { opacity: typeof opacity === "number" ? opacity : undefined },
      },
      children,
    );
  });

  return {
    default: { View },
    cancelAnimation: vi.fn(),
    Easing: {
      out: (easing: unknown) => easing,
      cubic: "cubic",
    },
    LinearTransition: {
      duration: () => ({ easing: () => undefined }),
    },
    ReduceMotion: { System: "system" },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (initial: number) => {
      const [, setVersion] = ReactModule.useState(0);
      const store = ReactModule.useRef<{ value: number } | null>(null);
      if (store.current === null) {
        let inner = initial;
        store.current = {
          get value() {
            return inner;
          },
          set value(next: number) {
            if (Object.is(inner, next)) {
              return;
            }
            inner = next;
            setVersion((version) => version + 1);
          },
        };
      }
      return store.current;
    },
    withTiming: (value: unknown) => value,
  };
});

import { ChatEntryMotion } from "./chat-entry-motion";

interface ViewportIntersection {
  isIntersecting: boolean;
}

interface FakeObserver {
  callback: (entries: ViewportIntersection[]) => void;
  disconnect: ReturnType<typeof vi.fn>;
}

describe("ChatEntryMotion", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let observers: FakeObserver[] = [];

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    observers = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class FakeIntersectionObserver {
        disconnect: ReturnType<typeof vi.fn>;
        constructor(callback: (entries: ViewportIntersection[]) => void) {
          this.disconnect = vi.fn();
          observers.push({ callback, disconnect: this.disconnect });
        }
        observe() {}
        unobserve() {}
      },
    );
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
    observers = [];
    vi.unstubAllGlobals();
  });

  function renderEntry(animateOnMount: boolean) {
    act(() => {
      root?.render(
        <div data-testid="agent-chat-scroll">
          <ChatEntryMotion animateOnMount={animateOnMount} testID="stream-item">
            row
          </ChatEntryMotion>
        </div>,
      );
    });
  }

  function entryOpacity(): number {
    const entry = container?.querySelector('[data-testid="stream-item"]');
    if (!(entry instanceof HTMLElement)) {
      throw new Error("Expected chat entry host");
    }
    return Number.parseFloat(entry.style.opacity);
  }

  it("snaps a completed off-screen row to rest instead of leaving it transparent", () => {
    renderEntry(true);
    expect(observers).toHaveLength(1);
    expect(entryOpacity()).toBe(0);

    renderEntry(false);
    expect(observers[0]?.disconnect).toHaveBeenCalled();
    expect(entryOpacity()).toBe(1);
  });

  it("plays entry motion once the off-screen row intersects the chat viewport", () => {
    renderEntry(true);
    expect(entryOpacity()).toBe(0);

    const observer = observers[0];
    if (!observer) {
      throw new Error("Expected a chat viewport observer");
    }
    act(() => {
      observer.callback([{ isIntersecting: true }]);
    });
    expect(entryOpacity()).toBe(1);
  });
});
