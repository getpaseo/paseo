import { describe, expect, it } from "vitest";
import { normalizeBackgroundTaskDisplayType } from "./type-badge";

describe("normalizeBackgroundTaskDisplayType", () => {
  it("maps known types", () => {
    expect(normalizeBackgroundTaskDisplayType("shell")).toBe("shell");
    expect(normalizeBackgroundTaskDisplayType("bash")).toBe("shell");
    expect(normalizeBackgroundTaskDisplayType("monitor")).toBe("monitor");
    expect(normalizeBackgroundTaskDisplayType("workflow")).toBe("workflow");
    expect(normalizeBackgroundTaskDisplayType("mystery")).toBe("other");
  });
});
