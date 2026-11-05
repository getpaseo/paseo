import { describe, expect, it } from "vitest";
import { pluginButtonTestId } from "./test-id";

describe("pluginButtonTestId", () => {
  it("uses the registered button key as the stable styling selector", () => {
    expect(pluginButtonTestId("feishu", "binding")).toBe("plugin-button-feishu-binding");
    expect(pluginButtonTestId("paseo-chat-polish", "prompts")).toBe(
      "plugin-button-paseo-chat-polish-prompts",
    );
  });
});
