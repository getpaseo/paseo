import { describe, expect, it } from "vitest";

import { formatShortcut } from "./format-shortcut";

describe("formatShortcut", () => {
  it("uses symbols on macOS", () => {
    expect(formatShortcut(["mod", "B"], "mac")).toBe("⌘B");
    expect(formatShortcut(["mod", "E"], "mac")).toBe("⌘E");
  });

  it("spells out Shift in shortcut labels", () => {
    expect(formatShortcut(["shift", "Tab"], "mac")).toBe("Shift+Tab");
    expect(formatShortcut(["mod", "shift", "P"], "mac")).toBe("Shift+⌘+P");
    expect(formatShortcut(["shift", "Tab"], "non-mac")).toBe("Shift+Tab");
  });

  it("uses Ctrl+ on non-mac platforms", () => {
    expect(formatShortcut(["mod", "B"], "non-mac")).toBe("Ctrl+B");
    expect(formatShortcut(["mod", "E"], "non-mac")).toBe("Ctrl+E");
  });
});
