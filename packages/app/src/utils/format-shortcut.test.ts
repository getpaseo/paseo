import { describe, expect, it } from "vitest";

import { formatCompactShortcut, formatShortcut } from "./format-shortcut";

describe("formatShortcut", () => {
  it("uses symbols on macOS", () => {
    expect(formatShortcut(["mod", "B"], "mac")).toBe("⌘B");
    expect(formatShortcut(["mod", "E"], "mac")).toBe("⌘E");
  });

  it("uses the Shift symbol on macOS and spells it out elsewhere", () => {
    expect(formatShortcut(["shift", "Tab"], "mac")).toBe("⇧Tab");
    expect(formatShortcut(["mod", "shift", "P"], "mac")).toBe("⇧⌘P");
    expect(formatShortcut(["shift", "Tab"], "non-mac")).toBe("Shift+Tab");
  });

  it("uses Ctrl+ on non-mac platforms", () => {
    expect(formatShortcut(["mod", "B"], "non-mac")).toBe("Ctrl+B");
    expect(formatShortcut(["mod", "E"], "non-mac")).toBe("Ctrl+E");
  });

  it("uses compact modifier symbols for control hints", () => {
    expect(formatCompactShortcut(["mod", "shift", "M"], "non-mac")).toBe("⌃⇧M");
    expect(formatCompactShortcut(["mod", "alt", "F"], "non-mac")).toBe("⌃⌥F");
    expect(formatCompactShortcut(["meta", "M"], "non-mac")).toBe("⊞M");
    expect(formatCompactShortcut(["mod", "shift", "M"], "mac")).toBe("⌘⇧M");
  });
});
