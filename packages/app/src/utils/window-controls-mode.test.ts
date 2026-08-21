import { describe, expect, it } from "vitest";

import {
  isRestoreMode,
  MIDDLE_CONTROL_LABEL,
  resolveMiddleControlMode,
} from "./window-controls-mode";

describe("resolveMiddleControlMode", () => {
  it("offers maximize on a restored window", () => {
    expect(resolveMiddleControlMode({ maximized: false, fullscreen: false })).toBe("maximize");
  });

  it("offers restore on a maximized window", () => {
    expect(resolveMiddleControlMode({ maximized: true, fullscreen: false })).toBe("restore");
  });

  it("offers restore in fullscreen, where the OS reports the window as not maximized", () => {
    expect(resolveMiddleControlMode({ maximized: false, fullscreen: true })).toBe(
      "restore-fullscreen",
    );
  });

  it("lets fullscreen pick the action when the OS reports both", () => {
    // Leaving fullscreen is a different call from unmaximising, so the action has to follow
    // fullscreen even though the button reads the same either way.
    expect(resolveMiddleControlMode({ maximized: true, fullscreen: true })).toBe(
      "restore-fullscreen",
    );
  });

  it("uses Windows' vocabulary, so both large states read as Restore", () => {
    expect(MIDDLE_CONTROL_LABEL.maximize).toBe("Maximize");
    expect(MIDDLE_CONTROL_LABEL.restore).toBe("Restore");
    expect(MIDDLE_CONTROL_LABEL["restore-fullscreen"]).toBe("Restore");
  });

  it("draws the restore glyph for both large states", () => {
    expect(isRestoreMode("restore")).toBe(true);
    expect(isRestoreMode("restore-fullscreen")).toBe(true);
    expect(isRestoreMode("maximize")).toBe(false);
  });
});
