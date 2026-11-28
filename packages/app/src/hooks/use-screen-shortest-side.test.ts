import { describe, expect, it } from "vitest";
import { readShortestScreenSide } from "./use-screen-shortest-side";

const source = (
  screen: { width: number; height: number },
  window: { width: number; height: number },
) => ({
  get: (kind: "window" | "screen") => (kind === "screen" ? screen : window),
});

const tabletScreen = { width: 1244, height: 880 };

describe("readShortestScreenSide", () => {
  it("reads the screen when the keyboard has shrunk the window", () => {
    // Android is configured with softwareKeyboardLayoutMode resize: the window loses the keyboard.
    expect(readShortestScreenSide(source(tabletScreen, { width: 1244, height: 480 }))).toBe(880);
  });

  it("does not move for a window-only resize", () => {
    expect(readShortestScreenSide(source(tabletScreen, { width: 1244, height: 320 }))).toBe(880);
  });

  it("follows a rotation, which swaps the sides without changing the shortest one", () => {
    expect(
      readShortestScreenSide(source({ width: 880, height: 1244 }, { width: 880, height: 1244 })),
    ).toBe(880);
  });
});
