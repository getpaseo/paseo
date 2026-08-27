import { afterEach, describe, expect, it } from "vitest";
import type { BrowserMirrorInput } from "./input-surface.types";
import { attachMouseInput, type MouseInputState } from "./mouse-input";

interface Surface {
  element: HTMLElement;
  state: MouseInputState;
  inputs: BrowserMirrorInput[];
  focusCount: number;
  detach: () => void;
}

const surfaces: Surface[] = [];

function attachSurface(): Surface {
  const element = document.createElement("div");
  element.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px";
  document.body.appendChild(element);
  const surface = {
    element,
    inputs: [],
    focusCount: 0,
    state: {
      fit: { scale: 1, offsetX: 0, offsetY: 0 },
      guest: { deviceWidth: 400, deviceHeight: 300 },
      isInteractive: true,
      onInput: (input) => surface.inputs.push(input),
      onFocusKeyboard: () => {
        surface.focusCount += 1;
      },
    },
  } as Surface;
  surface.detach = attachMouseInput(element, { current: surface.state });
  surfaces.push(surface);
  return surface;
}

const mouse = (type: string, init: MouseEventInit) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const pointer = (phase: "down" | "move" | "hover" | "up", x: number, y: number) => ({
  kind: "pointer" as const,
  phase,
  x,
  y,
  button: "left" as const,
  clickCount: 1,
  modifiers: [],
});

afterEach(() => {
  for (const surface of surfaces.splice(0)) {
    surface.detach();
    surface.element.remove();
  }
});

describe("mirror mouse input", () => {
  it("sends one newest move per frame between press and release", async () => {
    const surface = attachSurface();
    surface.element.dispatchEvent(mouse("mousedown", { clientX: 10, clientY: 20, button: 0 }));
    window.dispatchEvent(mouse("mousemove", { clientX: 20, clientY: 30 }));
    window.dispatchEvent(mouse("mousemove", { clientX: 44, clientY: 55 }));
    await nextFrame();
    window.dispatchEvent(mouse("mousemove", { clientX: 100, clientY: 100 }));
    window.dispatchEvent(mouse("mouseup", { clientX: 900, clientY: 40 }));
    await nextFrame();

    expect(surface.inputs).toEqual([
      pointer("down", 10, 20),
      pointer("move", 44, 55),
      pointer("up", 400, 40),
    ]);
    expect(surface.focusCount).toBe(1);
  });

  it("passes click count and modifiers through", () => {
    const surface = attachSurface();
    surface.element.dispatchEvent(
      mouse("mousedown", {
        clientX: 30,
        clientY: 30,
        button: 0,
        detail: 2,
        shiftKey: true,
      }),
    );
    expect(surface.inputs).toEqual([
      { ...pointer("down", 30, 30), clickCount: 2, modifiers: ["Shift"] },
    ]);
  });

  it("forwards unpressed movement as hover", async () => {
    const surface = attachSurface();
    window.dispatchEvent(mouse("mousemove", { clientX: 50, clientY: 50 }));
    await nextFrame();
    expect(surface.inputs).toEqual([pointer("hover", 50, 50)]);
  });

  it.each([
    [1, -1, 3, -16, 48],
    [2, 0, 1, 0, 300],
  ])("normalizes wheel delta mode %i", (deltaMode, deltaX, deltaY, expectedX, expectedY) => {
    const surface = attachSurface();
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
      deltaX,
      deltaY,
      deltaMode,
    });
    surface.element.dispatchEvent(wheel);
    expect(surface.inputs).toEqual([
      { kind: "wheel", x: 40, y: 60, deltaX: expectedX, deltaY: expectedY },
    ]);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("sends nothing without a frame to map against", () => {
    const surface = attachSurface();
    surface.state.fit = null;
    surface.element.dispatchEvent(mouse("mousedown", { clientX: 10, clientY: 10, button: 0 }));
    expect(surface.inputs).toEqual([]);
  });

  it("stops listening once detached", () => {
    const surface = attachSurface();
    surface.detach();
    surface.element.dispatchEvent(mouse("mousedown", { clientX: 10, clientY: 10, button: 0 }));
    window.dispatchEvent(mouse("mousemove", { clientX: 20, clientY: 20 }));
    expect(surface.inputs).toEqual([]);
  });
});
