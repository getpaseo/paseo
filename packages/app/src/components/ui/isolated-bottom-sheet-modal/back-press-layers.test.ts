import { describe, expect, it } from "vitest";
import { createBackPressLayers } from "./back-press-layers";
import type { BackPressSource } from "./visibility-tracker";

/**
 * Stands in for Android's `BackHandler`, which offers the press to listeners newest-first and
 * stops at the first one that claims it.
 */
class FakeBackHandler implements BackPressSource {
  listeners: (() => boolean)[] = [];

  subscribe(onBackPress: () => boolean): () => void {
    this.listeners.push(onBackPress);
    return () => {
      const index = this.listeners.indexOf(onBackPress);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** True when a listener claimed the press, false when Android handles it (leaving the app). */
  press(): boolean {
    for (let index = this.listeners.length - 1; index >= 0; index--) {
      if (this.listeners[index]?.()) return true;
    }
    return false;
  }
}

function setup() {
  const platform = new FakeBackHandler();
  const layers = createBackPressLayers(platform);
  const presses: string[] = [];
  const listener =
    (name: string, claims = true) =>
    () => {
      presses.push(name);
      return claims;
    };
  return { platform, ...layers, presses, listener };
}

describe("Back press layers", () => {
  it("offers Back to an overlay before a screen that subscribed after it", () => {
    const { platform, overlay, screen, presses, listener } = setup();
    overlay.subscribe(listener("composer"));
    screen.subscribe(listener("workspace"));

    expect(platform.press()).toBe(true);
    expect(presses).toEqual(["composer"]);
  });

  it("offers Back to a screen once no overlay claims it", () => {
    const { platform, overlay, screen, presses, listener } = setup();
    screen.subscribe(listener("workspace"));
    const closeSheet = overlay.subscribe(listener("sheet"));
    closeSheet();

    expect(platform.press()).toBe(true);
    expect(presses).toEqual(["workspace"]);
  });

  it("offers Back to overlays newest first, then screens newest first", () => {
    const { platform, overlay, screen, presses, listener } = setup();
    screen.subscribe(listener("older screen", false));
    screen.subscribe(listener("newer screen", false));
    overlay.subscribe(listener("older overlay", false));
    overlay.subscribe(listener("newer overlay", false));

    expect(platform.press()).toBe(false);
    expect(presses).toEqual(["newer overlay", "older overlay", "newer screen", "older screen"]);
  });

  it("holds one platform listener while any layer has a listener", () => {
    const { platform, overlay, screen, listener } = setup();
    const removeScreen = screen.subscribe(listener("workspace"));
    const removeOverlay = overlay.subscribe(listener("sheet"));
    expect(platform.listeners).toHaveLength(1);

    removeScreen();
    expect(platform.listeners).toHaveLength(1);
    removeOverlay();
    expect(platform.listeners).toHaveLength(0);
  });

  it("ignores a second removal of the same listener", () => {
    const { platform, overlay, screen, presses, listener } = setup();
    screen.subscribe(listener("workspace"));
    const removeSheet = overlay.subscribe(listener("sheet"));
    removeSheet();
    removeSheet();

    expect(platform.press()).toBe(true);
    expect(presses).toEqual(["workspace"]);
  });
});
