import { describe, expect, it } from "vitest";
import { isNarrowHomePane } from "./open-project-layout";

describe("home card layout", () => {
  it("uses a vertical list for narrow panes and two columns for wide panes", () => {
    expect(isNarrowHomePane(390)).toBe(true);
    expect(isNarrowHomePane(539)).toBe(true);
    expect(isNarrowHomePane(540)).toBe(false);
    expect(isNarrowHomePane(800)).toBe(false);
  });
});
