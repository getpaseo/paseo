import { afterEach, describe, expect, it } from "vitest";
import { attachMouseInput, type MouseInputState } from "./mouse-input";
import type { BrowserMirrorInput } from "./input-surface.types";

const GUEST = { deviceWidth: 400, deviceHeight: 300 };
const FIT = { scale: 1, offsetX: 0, offsetY: 0 };

interface AttachedSurface {
  element: HTMLElement;
  state: MouseInputState;
  inputs: BrowserMirrorInput[];
  focusCount: number;
}

const detachers: Array<() => void> = [];
const elements: HTMLElement[] = [];

function attachSurface(): AttachedSurface {
  const element = document.createElement("div");
  element.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px";
  document.body.appendChild(element);
  elements.push(element);

  const surface: AttachedSurface = {
    element,
    inputs: [],
    focusCount: 0,
    state: {
      fit: FIT,
      guest: GUEST,
      isInteractive: true,
      onInput: (event) => surface.inputs.push(event),
      onFocusKeyboard: () => {
        surface.focusCount += 1;
      },
    },
  };
  detachers.push(attachMouseInput(element, { current: surface.state }));
  return surface;
}

function mouse(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

afterEach(() => {
  for (const detach of detachers.splice(0)) {
    detach();
  }
  for (const element of elements.splice(0)) {
    element.remove();
  }
});

describe("mirror mouse input", () => {
  it("splits a drag into press, move, and release phases", async () => {
    const surface = attachSurface();

    surface.element.dispatchEvent(
      mouse("mousedown", { clientX: 10, clientY: 20, button: 0, detail: 1 }),
    );
    window.dispatchEvent(mouse("mousemove", { clientX: 120, clientY: 40, buttons: 1 }));
    await nextFrame();
    // Past the right edge: the drag has to survive leaving the pane.
    window.dispatchEvent(mouse("mouseup", { clientX: 900, clientY: 40, detail: 1 }));

    expect(surface.inputs).toEqual([
      {
        kind: "pointer",
        phase: "down",
        x: 10,
        y: 20,
        button: "left",
        clickCount: 1,
        modifiers: [],
      },
      {
        kind: "pointer",
        phase: "move",
        x: 120,
        y: 40,
        button: "left",
        clickCount: 1,
        modifiers: [],
      },
      { kind: "pointer", phase: "up", x: 400, y: 40, button: "left", clickCount: 1, modifiers: [] },
    ]);
    expect(surface.focusCount).toBe(1);
  });

  it("sends one move per frame, carrying the newest position", async () => {
    const surface = attachSurface();
    surface.element.dispatchEvent(
      mouse("mousedown", { clientX: 10, clientY: 10, button: 0, detail: 1 }),
    );

    window.dispatchEvent(mouse("mousemove", { clientX: 20, clientY: 20, buttons: 1 }));
    window.dispatchEvent(mouse("mousemove", { clientX: 30, clientY: 30, buttons: 1 }));
    window.dispatchEvent(mouse("mousemove", { clientX: 44, clientY: 55, buttons: 1 }));
    await nextFrame();

    // A guest that gets a move per mouse event spends the frame budget on
    // coordinates it will never paint.
    const moves = surface.inputs.filter(
      (input) => input.kind === "pointer" && input.phase !== "down",
    );
    expect(moves).toEqual([
      {
        kind: "pointer",
        phase: "move",
        x: 44,
        y: 55,
        button: "left",
        clickCount: 1,
        modifiers: [],
      },
    ]);
  });

  it("drops a move the release already overtook", async () => {
    const surface = attachSurface();
    surface.element.dispatchEvent(
      mouse("mousedown", { clientX: 10, clientY: 10, button: 0, detail: 1 }),
    );

    window.dispatchEvent(mouse("mousemove", { clientX: 20, clientY: 20, buttons: 1 }));
    window.dispatchEvent(mouse("mouseup", { clientX: 25, clientY: 25, detail: 1 }));
    await nextFrame();

    expect(surface.inputs.map((input) => input.kind === "pointer" && input.phase)).toEqual([
      "down",
      "up",
    ]);
  });

  it("passes the browser's click count and modifiers through", () => {
    const surface = attachSurface();

    surface.element.dispatchEvent(
      mouse("mousedown", { clientX: 30, clientY: 30, button: 0, detail: 2, shiftKey: true }),
    );

    expect(surface.inputs).toEqual([
      {
        kind: "pointer",
        phase: "down",
        x: 30,
        y: 30,
        button: "left",
        clickCount: 2,
        modifiers: ["Shift"],
      },
    ]);
  });

  it("ignores moves when no button is held", async () => {
    const surface = attachSurface();

    window.dispatchEvent(mouse("mousemove", { clientX: 50, clientY: 50 }));
    await nextFrame();

    expect(surface.inputs).toEqual([]);
  });

  it("scales line-mode wheel deltas to pixels and consumes the event", () => {
    const surface = attachSurface();

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
      deltaX: -1,
      deltaY: 3,
      deltaMode: 1,
    });
    surface.element.dispatchEvent(wheel);

    expect(surface.inputs).toEqual([{ kind: "wheel", x: 40, y: 60, deltaX: -16, deltaY: 48 }]);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("scales page-mode wheel deltas by the guest viewport", () => {
    const surface = attachSurface();

    surface.element.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
        deltaX: 0,
        deltaY: 1,
        deltaMode: 2,
      }),
    );

    expect(surface.inputs).toEqual([{ kind: "wheel", x: 10, y: 10, deltaX: 0, deltaY: 300 }]);
  });

  it("sends nothing while the pane has no frame to map against", () => {
    const surface = attachSurface();
    surface.state.fit = null;

    surface.element.dispatchEvent(
      mouse("mousedown", { clientX: 10, clientY: 10, button: 0, detail: 1 }),
    );

    expect(surface.inputs).toEqual([]);
  });

  it("stops listening once detached, so a released pane cannot keep driving the guest", () => {
    const surface = attachSurface();
    for (const detach of detachers.splice(0)) {
      detach();
    }

    surface.element.dispatchEvent(
      mouse("mousedown", { clientX: 10, clientY: 10, button: 0, detail: 1 }),
    );
    window.dispatchEvent(mouse("mousemove", { clientX: 20, clientY: 20, buttons: 1 }));

    expect(surface.inputs).toEqual([]);
  });
});
