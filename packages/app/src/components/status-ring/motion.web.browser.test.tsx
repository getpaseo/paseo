import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusRing } from "@/components/status-ring";
import { StatusRingFrame, StatusRingInk } from "@/components/status-ring/frame";
import {
  STATUS_PULSE_PERIOD_MS,
  STATUS_RING_FRAME_SIZE,
  getStatusPulseProgress,
  getStatusPulseScale,
} from "@/components/status-ring/geometry";
import { StatusPulse } from "@/components/status-ring/motion";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A real browser, because the motion under test only exists there: the pulse and the colour cycle
 * are Web Animations on the document timeline, which jsdom cannot run. Each check pauses the real
 * animation at a chosen moment and reads what the browser computes, so nothing depends on when the
 * test happens to run.
 */

// The light dot band, as the test theme carries it.
const RUNNING = "rgb(38, 138, 224)";
const SUCCESS = "rgb(41, 159, 81)";

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  const mark = container.firstElementChild;
  if (!(mark instanceof HTMLElement)) {
    throw new Error("nothing rendered");
  }
  return mark;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function child(element: Element | null | undefined, index: number): HTMLElement {
  const found = element?.children[index];
  if (!(found instanceof HTMLElement)) {
    throw new Error(`missing child ${index}`);
  }
  return found;
}

/** The success copy breathing over the running mark: the carrier's last child. */
function toneLayer(mark: HTMLElement): HTMLElement {
  return child(mark, mark.children.length - 1);
}

function pauseAt(element: HTMLElement, timeMs: number): void {
  for (const animation of element.getAnimations()) {
    animation.pause();
    animation.currentTime = timeMs;
  }
}

function breathAt(mark: HTMLElement, timeMs: number) {
  const tone = toneLayer(mark);
  pauseAt(mark, timeMs);
  pauseAt(tone, timeMs);
  return {
    scale: Number(new DOMMatrixReadOnly(getComputedStyle(mark).transform).a.toFixed(4)),
    successOpacity: Number(Number(getComputedStyle(tone).opacity).toFixed(4)),
  };
}

function expectedBreathAt(timeMs: number) {
  const progress = getStatusPulseProgress(timeMs);
  return {
    scale: Number(getStatusPulseScale(progress).toFixed(4)),
    successOpacity: Number(progress.toFixed(4)),
  };
}

function timingOf(element: HTMLElement) {
  return element.getAnimations().map((animation) => ({
    startTime: animation.startTime,
    duration: animation.effect?.getTiming().duration,
    iterations: animation.effect?.getTiming().iterations,
  }));
}

function isRotation(animation: Animation): boolean {
  const effect = animation.effect;
  return (
    effect instanceof KeyframeEffect &&
    effect.getKeyframes().some((keyframe) => String(keyframe.transform).startsWith("rotate"))
  );
}

/** The ring's three coloured parts, in the order the ink draws them: track, quarter, centre. */
function ringInkColors(ink: HTMLElement) {
  const quarter = child(child(ink, 1), 0);
  return {
    track: getComputedStyle(child(ink, 0)).borderLeftColor,
    quarter: getComputedStyle(quarter).borderTopColor,
    centre: getComputedStyle(child(ink, 2)).backgroundColor,
  };
}

const BREATH_MOMENTS = [0, 0.25, 0.5, 0.75].map((fraction) => fraction * STATUS_PULSE_PERIOD_MS);

describe("running status ring", () => {
  it("breathes on the one document-timeline epoch every ring shares", () => {
    const marks = [mount(<StatusRing backdrop="surface2" />), mount(<StatusRing />)];
    const shared = { startTime: 0, duration: STATUS_PULSE_PERIOD_MS, iterations: Infinity };

    for (const mark of marks) {
      expect(timingOf(mark)).toEqual([shared]);
      expect(timingOf(toneLayer(mark))).toEqual([shared]);
    }
  });

  it("swells from the running colour to the success colour and back on the shared curve", () => {
    const ring = mount(<StatusRing />);

    expect(BREATH_MOMENTS.map((timeMs) => breathAt(ring, timeMs))).toEqual([
      { scale: 1, successOpacity: 0 },
      expectedBreathAt(BREATH_MOMENTS[1] ?? 0),
      { scale: 1.12, successOpacity: 1 },
      expectedBreathAt(BREATH_MOMENTS[3] ?? 0),
    ]);
  });

  it("stays on the native curve between its sampled keyframes", () => {
    const ring = mount(<StatusRing />);
    // Halfway between the first two of the web keyframes, where sampling strays furthest.
    const between = STATUS_PULSE_PERIOD_MS / 48;
    const { successOpacity } = breathAt(ring, between);

    expect(Math.abs(successOpacity - getStatusPulseProgress(between))).toBeLessThan(0.005);
  });

  it("draws the running ink under a success copy, each in the theme's dot colour", () => {
    const ring = mount(<StatusRing backdrop="surface2" />);
    const runningInk = child(ring, 0);
    const successInk = toneLayer(ring);

    expect(ringInkColors(runningInk)).toEqual({
      track: RUNNING,
      quarter: RUNNING,
      centre: RUNNING,
    });
    expect(ringInkColors(successInk)).toEqual({
      track: SUCCESS,
      quarter: SUCCESS,
      centre: SUCCESS,
    });
  });

  it("keeps the quarter turning on both inks, in step", () => {
    const ring = mount(<StatusRing />);
    const rotations = ring.getAnimations({ subtree: true }).filter(isRotation);

    expect(rotations.map((animation) => animation.startTime)).toEqual([0, 0]);
  });

  it("occupies exactly the frame's box, with the success copy laid over it", () => {
    const ring = mount(<StatusRing backdrop="surface2" />);
    pauseAt(ring, 0);
    const frame = child(ring, 0).getBoundingClientRect();
    const tone = toneLayer(ring).getBoundingClientRect();

    expect([ring.offsetWidth, ring.offsetHeight]).toEqual([
      STATUS_RING_FRAME_SIZE,
      STATUS_RING_FRAME_SIZE,
    ]);
    expect([tone.left, tone.top, tone.width, tone.height]).toEqual([
      frame.left,
      frame.top,
      frame.width,
      frame.height,
    ]);
  });
});

describe("status pulse with reduced motion", () => {
  function mountRing(reduceMotion: boolean): HTMLElement {
    return mount(
      <StatusPulse size={STATUS_RING_FRAME_SIZE} reduceMotion={reduceMotion}>
        <StatusRingFrame backdrop="surface2">
          <StatusRingInk tone="running" />
        </StatusRingFrame>
        <StatusRingInk tone="success" />
      </StatusPulse>,
    );
  }

  it("holds the running ring still in its own colour, its quarter still turning", () => {
    const ring = mountRing(true);
    const animations = ring.getAnimations({ subtree: true });

    // No carrier and no success copy: the frame is the whole mark, exactly as before the breath.
    expect(ring.children).toHaveLength(3);
    expect(ringInkColors(ring)).toEqual({ track: RUNNING, quarter: RUNNING, centre: RUNNING });
    expect([ring.offsetWidth, ring.offsetHeight]).toEqual([
      STATUS_RING_FRAME_SIZE,
      STATUS_RING_FRAME_SIZE,
    ]);
    expect(animations.map(isRotation)).toEqual([true]);
  });

  it("breathes when motion is allowed", () => {
    const ring = mountRing(false);
    const animations = ring.getAnimations({ subtree: true });

    expect(animations.filter((animation) => !isRotation(animation))).toHaveLength(2);
    expect(ringInkColors(toneLayer(ring))).toEqual({
      track: SUCCESS,
      quarter: SUCCESS,
      centre: SUCCESS,
    });
  });
});
