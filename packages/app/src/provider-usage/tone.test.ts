import { describe, expect, it } from "vitest";
import { resolveWindowBarTone } from "./tone";

describe("provider usage window bar tone", () => {
  it("uses green for remaining capacity even when usage is at risk", () => {
    expect(resolveWindowBarTone("remaining", 95, "danger")).toBe("ok");
  });

  it("uses consumption risk tone when displaying used percentage", () => {
    expect(resolveWindowBarTone("used", 95, undefined)).toBe("danger");
  });
});
