import { describe, expect, it } from "vitest";

import { formatShortcut } from "./format-shortcut";

describe("formatShortcut", () => {
  it("uses symbols on macOS", () => {
    expect(formatShortcut(["mod", "B"], "mac")).toBe("⌘B");
    expect(formatShortcut(["mod", "E"], "mac")).toBe("⌘E");
  });

  it("uses Ctrl+ on non-mac platforms", () => {
    expect(formatShortcut(["mod", "B"], "non-mac")).toBe("Ctrl+B");
    expect(formatShortcut(["mod", "E"], "non-mac")).toBe("Ctrl+E");
  });
});

