import { describe, expect, it } from "vitest";
import { darkTheme } from "@/styles/theme";
import { appearanceStyleBoundaryKey } from "./appearance-style-boundary";

describe("appearanceStyleBoundaryKey", () => {
  it("changes when content size changes without any other appearance token changing", () => {
    const contentOnlyChange = {
      ...darkTheme,
      fontSize: { ...darkTheme.fontSize, content: darkTheme.fontSize.content + 1 },
    };

    expect(appearanceStyleBoundaryKey(contentOnlyChange)).not.toBe(
      appearanceStyleBoundaryKey(darkTheme),
    );
  });
});
