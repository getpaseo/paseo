import { describe, expect, it } from "vitest";

import { darkGhosttyTheme, darkTheme, lightTheme } from "@/styles/theme";
import { toTerminalXtermTheme } from "./to-xterm-theme";

describe("toTerminalXtermTheme", () => {
  it("uses the canonical dark terminal palette under a light interface", () => {
    expect(toTerminalXtermTheme(lightTheme)).toEqual(darkTheme.colors.terminal);
  });

  it("preserves the active terminal palette under a dark interface", () => {
    expect(toTerminalXtermTheme(darkGhosttyTheme)).toEqual(darkGhosttyTheme.colors.terminal);
  });
});
