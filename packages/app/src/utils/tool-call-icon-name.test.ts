import { describe, expect, it } from "vitest";
import { resolveToolCallIconName } from "./tool-call-icon-name";

describe("resolveToolCallIconName", () => {
  it("uses the bot icon for task sub-agent details", () => {
    const icon = resolveToolCallIconName("Task", {
      type: "sub_agent",
      subAgentType: "Explore",
      description: "Inspect repository",
      log: "[Read] README.md",
    });

    expect(icon).toBe("bot");
  });

  it("uses the bot icon for task calls without canonical detail", () => {
    const icon = resolveToolCallIconName("Task", {
      type: "unknown",
      input: null,
      output: null,
    });

    expect(icon).toBe("bot");
    expect(resolveToolCallIconName("Task")).toBe("bot");
  });

  it("keeps the brain icon override for thinking calls with unknown detail", () => {
    const icon = resolveToolCallIconName("thinking", {
      type: "unknown",
      input: null,
      output: null,
    });

    expect(icon).toBe("brain");
  });

  it("uses the custom icon from plain_text detail", () => {
    const icon = resolveToolCallIconName("custom_tool", {
      type: "plain_text",
      label: "Background task completed",
      icon: "sparkles",
      text: "notification payload",
    });

    expect(icon).toBe("sparkles");
  });

  it("does not special-case skill tool names", () => {
    const icon = resolveToolCallIconName("skill", {
      type: "plain_text",
      label: "Skill output",
    });

    expect(icon).toBe("wrench");
  });
});
