import { describe, expect, it } from "vitest";
import { shouldAnchorHeaderBeforeCollapse } from "./git-diff-scroll";

describe("shouldAnchorHeaderBeforeCollapse", () => {
  it("skips anchor when header is fully visible in viewport", () => {
    expect(
      shouldAnchorHeaderBeforeCollapse({
        headerOffset: 120,
        headerHeight: 44,
        viewportOffset: 80,
        viewportHeight: 400,
      })
    ).toBe(false);
  });

  it("skips anchor when header is partially visible in viewport", () => {
    expect(
      shouldAnchorHeaderBeforeCollapse({
        headerOffset: 60,
        headerHeight: 44,
        viewportOffset: 80,
        viewportHeight: 300,
      })
    ).toBe(false);
  });

  it("anchors when header is above viewport", () => {
    expect(
      shouldAnchorHeaderBeforeCollapse({
        headerOffset: 200,
        headerHeight: 44,
        viewportOffset: 500,
        viewportHeight: 300,
      })
    ).toBe(true);
  });

  it("anchors when header is below viewport", () => {
    expect(
      shouldAnchorHeaderBeforeCollapse({
        headerOffset: 600,
        headerHeight: 44,
        viewportOffset: 100,
        viewportHeight: 300,
      })
    ).toBe(true);
  });

  it("anchors when viewport metrics are unavailable", () => {
    expect(
      shouldAnchorHeaderBeforeCollapse({
        headerOffset: 0,
        headerHeight: 44,
        viewportOffset: 0,
        viewportHeight: 0,
      })
    ).toBe(true);
  });
});
