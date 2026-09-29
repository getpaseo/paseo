import { describe, expect, it } from "vitest";
import { tintOver } from "./with-alpha";

describe("tintOver", () => {
  it("mixes a color into a background as a solid hex", () => {
    expect(tintOver("#ff0000", "#ffffff", 0.5)).toBe("#ff8080");
    expect(tintOver("#4176e6", "#f5f6f7", 0)).toBe("#f5f6f7");
  });
  it("leaves colors it cannot parse alone", () => {
    expect(tintOver("rgb(1,2,3)", "#ffffff", 0.5)).toBe("rgb(1,2,3)");
  });
});
