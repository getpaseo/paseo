import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusRing } from "@/components/status-ring";
import { STATUS_RING_PERIOD_MS } from "@/components/status-ring/geometry";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mountRingAnimation(): { rotator: HTMLElement; animation: Animation } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<StatusRing />));
  mounted.push({ root, container });

  const animated = [...container.querySelectorAll("*")].filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.getAnimations().length > 0,
  );
  const [rotator] = animated;
  const [animation] = rotator?.getAnimations() ?? [];
  if (animated.length !== 1 || !rotator || !animation) {
    throw new Error(`expected exactly one animated ring element, found ${animated.length}`);
  }
  return { rotator, animation };
}

describe("StatusRing on web", () => {
  // Every distinct rotation the ring shows is a frame the compositor must draw and the OS window
  // server must composite. A smooth rotation shows a new angle on every display refresh, so one
  // 14px ring kept an otherwise idle desktop window drawing 120 frames a second (#5429).
  it("turns through twelve discrete positions per revolution", () => {
    const { rotator, animation } = mountRingAnimation();
    animation.pause();

    const transforms = new Set<string>();
    for (let sample = 0; sample < 360; sample += 1) {
      animation.currentTime = (sample / 360) * STATUS_RING_PERIOD_MS;
      transforms.add(getComputedStyle(rotator).transform);
    }

    expect(transforms.size).toBe(12);
  });
});
