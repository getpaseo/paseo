import { describe, expect, it } from "vitest";
import { pluginButtonTestId } from "./test-id";

describe("pluginButtonTestId", () => {
  it("uses the registered button key as the stable styling selector", () => {
    expect(pluginButtonTestId(42)).toBe("plugin-button-42");
    expect(pluginButtonTestId("feishu/binding")).toBe("plugin-button-feishu/binding");
  });
});
