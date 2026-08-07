import { describe, expect, it } from "vitest";
import { resolveAssistantForkStrategy } from "./fork-strategy";

describe("resolveAssistantForkStrategy", () => {
  it("uses context fork for the default new-tab action", () => {
    expect(resolveAssistantForkStrategy("tab")).toBe("context");
  });

  it("uses context fork for new-workspace", () => {
    expect(resolveAssistantForkStrategy("workspace")).toBe("context");
  });

  it("uses native fork only for the experimental native-tab action", () => {
    expect(resolveAssistantForkStrategy("native-tab")).toBe("native");
  });
});
