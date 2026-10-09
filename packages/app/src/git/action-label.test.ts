import { describe, expect, it } from "vitest";

import { withCount } from "./action-label";

describe("withCount", () => {
  it("appends a positive count in parentheses", () => {
    expect(withCount("Pull", 3)).toBe("Pull (3)");
    expect(withCount("Push", 1)).toBe("Push (1)");
  });

  it("renders the bare label when the count is zero or undefined", () => {
    expect(withCount("Pull", 0)).toBe("Pull");
    expect(withCount("Pull", undefined)).toBe("Pull");
    expect(withCount("Push")).toBe("Push");
  });
});
