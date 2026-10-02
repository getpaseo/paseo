import { describe, expect, it } from "vitest";
import { resolveLayoutWindowWidth } from "./window-width";

describe("resolveLayoutWindowWidth", () => {
  it("uses the rendered root after a fold when RN Dimensions still reports the closed width", () => {
    expect(resolveLayoutWindowWidth(851.7, 443.1)).toBe(851.7);
    expect(resolveLayoutWindowWidth(443.1, 851.7)).toBe(443.1);
  });

  it("uses RN's initial width until the root has laid out", () => {
    expect(resolveLayoutWindowWidth(null, 411)).toBe(411);
    expect(resolveLayoutWindowWidth(0, 411)).toBe(411);
  });
});
