// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrubHandle } from "./scrub-handle.native";
import {
  SCRUB_ACTIVE_OFFSET_X,
  SCRUB_FAIL_OFFSET_Y,
  type ScrubHandleProps,
} from "./scrub-handle.types";

interface RecordedPan {
  config: Record<string, unknown>;
  handlers: Record<string, (event?: { translationX: number }) => void>;
}

const pans = vi.hoisted(() => [] as RecordedPan[]);

// Records how the handle configures its pan and keeps the callbacks, so a test can drive them
// as the native gesture system would.
vi.mock("react-native-gesture-handler", async () => {
  const ReactModule = await import("react");
  function pan(): unknown {
    const recorded: RecordedPan = { config: {}, handlers: {} };
    pans.push(recorded);
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of ["enabled", "runOnJS", "hitSlop", "activeOffsetX", "failOffsetY"]) {
      builder[name] = (value: unknown) => {
        recorded.config[name] = value;
        return builder;
      };
    }
    for (const name of ["onStart", "onUpdate", "onFinalize"]) {
      builder[name] = (handler: unknown) => {
        recorded.handlers[name] = handler as RecordedPan["handlers"][string];
        return builder;
      };
    }
    return builder;
  }
  return {
    Gesture: { Pan: pan },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  pans.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function props(overrides: Partial<ScrubHandleProps> = {}): ScrubHandleProps {
  return {
    disabled: false,
    onScrubStart: vi.fn(),
    onScrubMove: vi.fn(),
    onScrubEnd: vi.fn(),
    accessibilityLabel: "Max parallel",
    accessibilityHint: "Drag sideways",
    accessibilityValueText: "3",
    accessibilityActions: [{ name: "increment" }, { name: "decrement" }],
    onAccessibilityAction: vi.fn(),
    style: null,
    children: null,
    testID: "handle",
    ...overrides,
  };
}

function render(next: ScrubHandleProps): void {
  act(() => root?.render(<ScrubHandle {...next} />));
}

function latestPan(): RecordedPan {
  const pan = pans.at(-1);
  if (!pan) {
    throw new Error("the handle built no pan gesture");
  }
  return pan;
}

describe("ScrubHandle (native)", () => {
  it("activates on sideways travel and leaves vertical drags to the scroll view", () => {
    render(props());
    const { config } = latestPan();
    expect(config.activeOffsetX).toEqual([-SCRUB_ACTIVE_OFFSET_X, SCRUB_ACTIVE_OFFSET_X]);
    expect(config.failOffsetY).toEqual([-SCRUB_FAIL_OFFSET_Y, SCRUB_FAIL_OFFSET_Y]);
    expect(SCRUB_FAIL_OFFSET_Y).toBeGreaterThan(SCRUB_ACTIVE_OFFSET_X);
    expect(config.runOnJS).toBe(true);
    expect(config.enabled).toBe(true);
  });

  it("widens the 32pt handle to a 44pt touch target", () => {
    render(props());
    const slop = latestPan().config.hitSlop as { left: number; right: number };
    expect(32 + slop.left + slop.right).toBeGreaterThanOrEqual(44);
  });

  it("is disabled with the field", () => {
    render(props({ disabled: true }));
    expect(latestPan().config.enabled).toBe(false);
  });

  it("reports travel to the latest callbacks, not the ones of the first render", () => {
    const first = props();
    render(first);
    const second = props();
    render(second);
    const { handlers } = latestPan();
    act(() => {
      handlers.onStart?.();
      handlers.onUpdate?.({ translationX: 25 });
      handlers.onFinalize?.();
    });
    expect(first.onScrubMove).not.toHaveBeenCalled();
    expect(second.onScrubStart).toHaveBeenCalledTimes(1);
    expect(second.onScrubMove).toHaveBeenCalledWith(25, false);
    expect(second.onScrubEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps one gesture across renders while enabled is unchanged", () => {
    render(props());
    render(props({ accessibilityValueText: "4" }));
    expect(pans).toHaveLength(1);
  });
});
