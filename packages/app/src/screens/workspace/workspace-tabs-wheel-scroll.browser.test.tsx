import { act, renderHook } from "@testing-library/react";
import type { ScrollView } from "react-native";
import { describe, expect, it } from "vitest";
import { useWorkspaceTabsWheelScroll } from "@/screens/workspace/workspace-tabs-wheel-scroll.web";

interface WheelHookProps {
  enabled: boolean;
}

function createScrollableStrip(): HTMLDivElement {
  const strip = document.createElement("div");
  strip.style.width = "800px";
  strip.style.height = "20px";
  strip.style.overflow = "scroll";
  const content = document.createElement("div");
  content.style.width = "1600px";
  content.style.height = "1px";
  strip.append(content);
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: 800 },
    scrollWidth: { configurable: true, value: 1600 },
  });
  document.body.append(strip);
  return strip;
}

function recordWheelListener(strip: HTMLDivElement): () => number {
  const originalAddEventListener = strip.addEventListener.bind(strip);
  const originalRemoveEventListener = strip.removeEventListener.bind(strip);
  let added = 0;
  let removed = 0;
  strip.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "wheel") added += 1;
    originalAddEventListener(type, listener, options);
  }) as typeof strip.addEventListener;
  strip.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "wheel") removed += 1;
    originalRemoveEventListener(type, listener, options);
  }) as typeof strip.removeEventListener;
  return () => added - removed;
}

async function attachStripToHook(
  strip: HTMLDivElement,
  enabled = true,
  refValue: unknown = strip,
): Promise<{ rerender: (props: WheelHookProps) => void; unmount: () => void }> {
  const hook = renderHook(({ enabled: isEnabled }) => useWorkspaceTabsWheelScroll(isEnabled), {
    initialProps: { enabled: false },
  });
  (hook.result.current as { current: ScrollView | null }).current = refValue as ScrollView;
  await act(async () => {
    hook.rerender({ enabled });
  });
  expect(hook.result.current.current).toBe(refValue);
  return hook;
}

function wheel(deltaY: number, options: Partial<WheelEventInit> = {}): WheelEvent {
  return new WheelEvent("wheel", { cancelable: true, deltaY, ...options });
}

describe("useWorkspaceTabsWheelScroll", () => {
  it("pans a vertical wheel and prevents the browser default", async () => {
    const strip = createScrollableStrip();
    const activeListeners = recordWheelListener(strip);
    const scrollViewHandle = { getScrollableNode: () => strip };
    const hook = await attachStripToHook(strip, true, scrollViewHandle);
    expect(activeListeners()).toBe(1);
    const event = wheel(120);

    expect(strip.scrollWidth).toBe(1600);
    expect(strip.clientWidth).toBe(800);
    expect(event.deltaY).toBe(120);
    strip.dispatchEvent(event);

    expect(strip.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
    hook.unmount();
    expect(activeListeners()).toBe(0);
    strip.remove();
  });

  it("keeps horizontal and modifier gestures with the browser", async () => {
    const strip = createScrollableStrip();
    const hook = await attachStripToHook(strip);
    const horizontal = wheel(120, { deltaX: 20 });
    const shifted = wheel(120, { shiftKey: true });
    const zoom = wheel(120, { ctrlKey: true });

    strip.dispatchEvent(horizontal);
    strip.dispatchEvent(shifted);
    strip.dispatchEvent(zoom);

    expect(strip.scrollLeft).toBe(0);
    expect(horizontal.defaultPrevented).toBe(false);
    expect(shifted.defaultPrevented).toBe(false);
    expect(zoom.defaultPrevented).toBe(false);
    hook.unmount();
    strip.remove();
  });

  it("removes the listener when disabled or unmounted", async () => {
    const strip = createScrollableStrip();
    const hook = await attachStripToHook(strip);

    await act(async () => {
      hook.rerender({ enabled: false });
    });
    strip.dispatchEvent(wheel(120));
    expect(strip.scrollLeft).toBe(0);

    hook.unmount();
    strip.dispatchEvent(wheel(120));
    expect(strip.scrollLeft).toBe(0);
    strip.remove();
  });

  it("normalizes line and page wheel deltas through the public hook", async () => {
    const strip = createScrollableStrip();
    const hook = await attachStripToHook(strip);

    strip.dispatchEvent(wheel(3, { deltaMode: 1 }));
    expect(strip.scrollLeft).toBe(48);
    strip.dispatchEvent(wheel(1, { deltaMode: 2 }));
    expect(strip.scrollLeft).toBe(800);

    hook.unmount();
    strip.remove();
  });
});
