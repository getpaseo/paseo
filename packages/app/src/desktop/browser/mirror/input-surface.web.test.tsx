// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserMirrorInputSurface } from "./input-surface";
import type { BrowserMirrorInput } from "./input-surface.types";

const GUEST = { deviceWidth: 400, deviceHeight: 300 };
const FIT = { scale: 1, offsetX: 0, offsetY: 0 };

interface MountedSurface {
  root: Root;
  container: HTMLDivElement;
  surface: HTMLElement;
}

// Module scope keeps the recorders stable, which react-perf demands of any
// function reaching a JSX prop.
let inputs: BrowserMirrorInput[] = [];
let focusCount = 0;

function recordInput(event: BrowserMirrorInput): void {
  inputs.push(event);
}

function recordFocus(): void {
  focusCount += 1;
}

const mounted: MountedSurface[] = [];

function noop(): void {}

function mountSurface(): MountedSurface {
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px;display:flex";
  document.body.appendChild(container);
  const root = createRoot(container);
  inputs = [];
  focusCount = 0;

  act(() =>
    root.render(
      <BrowserMirrorInputSurface
        fit={FIT}
        guest={GUEST}
        isInteractive
        onInput={recordInput}
        onFocusKeyboard={recordFocus}
        onLayout={noop}
      >
        <div />
      </BrowserMirrorInputSurface>,
    ),
  );

  const surface = container.firstElementChild;
  if (!(surface instanceof HTMLElement)) {
    throw new Error("input surface did not render an element");
  }
  const entry = { root, container, surface };
  mounted.push(entry);
  return entry;
}

function mouse(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("BrowserMirrorInputSurface (web)", () => {
  it("splits a drag into press, move, and release phases", async () => {
    const { surface } = mountSurface();

    surface.dispatchEvent(mouse("mousedown", { clientX: 10, clientY: 20, button: 0, detail: 1 }));
    window.dispatchEvent(mouse("mousemove", { clientX: 120, clientY: 40, buttons: 1 }));
    await nextFrame();
    // Past the right edge: the drag has to survive leaving the pane.
    window.dispatchEvent(mouse("mouseup", { clientX: 900, clientY: 40, detail: 1 }));

    expect(inputs).toEqual([
      { kind: "mouse", x: 10, y: 20, button: "left", clickCount: 1, modifiers: [], phase: "down" },
      { kind: "mouse", x: 120, y: 40, button: "left", clickCount: 1, modifiers: [], phase: "move" },
      { kind: "mouse", x: 400, y: 40, button: "left", clickCount: 1, modifiers: [], phase: "up" },
    ]);
    expect(focusCount).toBe(1);
  });

  it("passes the browser's click count and modifiers through", () => {
    const { surface } = mountSurface();

    surface.dispatchEvent(
      mouse("mousedown", { clientX: 30, clientY: 30, button: 0, detail: 2, shiftKey: true }),
    );

    expect(inputs).toEqual([
      {
        kind: "mouse",
        x: 30,
        y: 30,
        button: "left",
        clickCount: 2,
        modifiers: ["Shift"],
        phase: "down",
      },
    ]);
  });

  it("ignores moves when no button is held", async () => {
    const { surface } = mountSurface();

    window.dispatchEvent(mouse("mousemove", { clientX: 50, clientY: 50 }));
    await nextFrame();

    expect(inputs).toEqual([]);
    expect(surface.isConnected).toBe(true);
  });

  it("scales line-mode wheel deltas to pixels and consumes the event", () => {
    const { surface } = mountSurface();

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
      deltaX: -1,
      deltaY: 3,
      deltaMode: 1,
    });
    surface.dispatchEvent(wheel);

    expect(inputs).toEqual([{ kind: "wheel", x: 40, y: 60, deltaX: -16, deltaY: 48 }]);
    expect(wheel.defaultPrevented).toBe(true);
  });
});
