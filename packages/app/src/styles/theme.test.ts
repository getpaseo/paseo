import { describe, expect, it } from "vitest";
import { darkAmoledTheme } from "./theme";

describe("AMOLED theme", () => {
  it("uses a pure black application and terminal background", () => {
    expect(darkAmoledTheme.colors.surface0).toBe("#000000");
    expect(darkAmoledTheme.colors.background).toBe("#000000");
    expect(darkAmoledTheme.colors.terminal.background).toBe("#000000");
  });
});
