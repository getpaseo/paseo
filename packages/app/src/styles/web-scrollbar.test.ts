import { describe, expect, it } from "vitest";
import { webScrollbarThumbColor } from "./web-scrollbar";

describe("web scrollbar color", () => {
  it("uses the resting opacity by default and full opacity when requested", () => {
    expect(webScrollbarThumbColor("gray")).toBe("color-mix(in srgb, gray 40%, transparent)");
    expect(webScrollbarThumbColor("gray", 1)).toBe("color-mix(in srgb, gray 100%, transparent)");
  });
});
