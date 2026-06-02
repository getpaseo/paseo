import { describe, expect, it } from "vitest";
import { resolveInlineImageSize } from "./inline-image-size";

describe("resolveInlineImageSize", () => {
  it("respects a one-sided explicit width using natural aspect ratio", () => {
    expect(
      resolveInlineImageSize({ explicit: { width: 18 }, natural: { width: 90, height: 45 } }),
    ).toEqual({
      width: 18,
      height: 9,
    });
  });

  it("respects a one-sided explicit height using natural aspect ratio", () => {
    expect(
      resolveInlineImageSize({ explicit: { height: 18 }, natural: { width: 90, height: 45 } }),
    ).toEqual({
      width: 36,
      height: 18,
    });
  });

  it("uses a generic small fallback when no dimensions are known", () => {
    expect(resolveInlineImageSize({ explicit: {}, natural: null })).toEqual({
      width: 16,
      height: 16,
    });
  });
});
