import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import { toXtermTheme } from "./to-xterm-theme";

describe("toXtermTheme", () => {
  it("returns the same object for equal palettes so identity-keyed theme effects stay quiet", () => {
    const first = toXtermTheme(darkTheme.colors.terminal);
    const second = toXtermTheme({ ...darkTheme.colors.terminal });

    expect(second).toBe(first);
    expect(first.background).toBe(darkTheme.colors.terminal.background);
  });

  it("returns a new object when any palette color changes", () => {
    const dark = toXtermTheme(darkTheme.colors.terminal);
    const light = toXtermTheme(lightTheme.colors.terminal);

    expect(light).not.toBe(dark);
    expect(light.background).toBe(lightTheme.colors.terminal.background);
    expect(toXtermTheme(darkTheme.colors.terminal).background).toBe(dark.background);
  });
});
