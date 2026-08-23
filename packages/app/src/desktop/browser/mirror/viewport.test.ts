import { describe, expect, it } from "vitest";
import { fitViewport, toGuestPoint } from "./viewport";

const guest = { deviceWidth: 1280, deviceHeight: 800 };

describe("browser mirror viewport mapping", () => {
  it("letterboxes horizontally when the pane is wider than the guest", () => {
    const fit = fitViewport({ width: 1600, height: 800 }, guest);

    expect(fit.scale).toBe(1);
    expect(fit.offsetX).toBe(160);
    expect(fit.offsetY).toBe(0);
  });

  it("letterboxes vertically when the pane is taller than the guest", () => {
    const fit = fitViewport({ width: 1280, height: 1000 }, guest);

    expect(fit.scale).toBe(1);
    expect(fit.offsetY).toBe(100);
    expect(fit.offsetX).toBe(0);
  });

  it("maps the pane centre to the guest centre", () => {
    const pane = { width: 640, height: 800 };
    const fit = fitViewport(pane, guest);

    expect(toGuestPoint({ x: pane.width / 2, y: pane.height / 2 }, fit, guest)).toEqual({
      x: 640,
      y: 400,
    });
  });

  it("maps a scaled-down pane back to full guest coordinates", () => {
    const fit = fitViewport({ width: 640, height: 400 }, guest);

    expect(fit.scale).toBe(0.5);
    expect(toGuestPoint({ x: 100, y: 50 }, fit, guest)).toEqual({ x: 200, y: 100 });
  });

  it("clamps points that land in the letterbox", () => {
    const fit = fitViewport({ width: 1600, height: 800 }, guest);

    expect(toGuestPoint({ x: 0, y: 0 }, fit, guest)).toEqual({ x: 0, y: 0 });
    expect(toGuestPoint({ x: 1600, y: 800 }, fit, guest)).toEqual({ x: 1280, y: 800 });
  });
});
