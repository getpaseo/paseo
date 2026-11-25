import { describe, expect, it } from "vitest";
import { SPACING } from "@/styles/theme";
import {
  resolveAddProjectKeyboardShift,
  resolveAddProjectPanelMaxHeight,
} from "./add-project-panel-height";

describe("resolveAddProjectKeyboardShift", () => {
  it("reserves the keyboard on iOS, where the window keeps its full frame", () => {
    expect(resolveAddProjectKeyboardShift("ios", 336)).toBe(336);
  });

  it("reserves nothing on Android, where the window already shrinks with the keyboard", () => {
    expect(resolveAddProjectKeyboardShift("android", 336)).toBe(0);
  });
});

describe("resolveAddProjectPanelMaxHeight", () => {
  it("keeps the resting 80% cap while the keyboard is closed", () => {
    expect(
      resolveAddProjectPanelMaxHeight({ overlayHeight: 844, keyboardShift: 0, safeAreaBottom: 34 }),
    ).toBeNull();
  });

  it("lowers the panel to the room above an open iOS keyboard and the home indicator", () => {
    expect(
      resolveAddProjectPanelMaxHeight({
        overlayHeight: 844,
        keyboardShift: 302,
        safeAreaBottom: 34,
      }),
    ).toBe(844 - SPACING[12] - 302 - 34);
  });

  it("never returns a negative height when the keyboard covers the overlay", () => {
    expect(
      resolveAddProjectPanelMaxHeight({
        overlayHeight: 400,
        keyboardShift: 500,
        safeAreaBottom: 34,
      }),
    ).toBe(0);
  });

  it("leaves the cap alone before the overlay has been measured", () => {
    expect(
      resolveAddProjectPanelMaxHeight({ overlayHeight: 0, keyboardShift: 302, safeAreaBottom: 34 }),
    ).toBeNull();
  });
});
