import { describe, expect, it, vi } from "vitest";

const iconMocks = vi.hoisted(() => ({
  Bot: () => null,
  Brain: () => null,
  Eye: () => null,
  MicVocal: () => null,
  Pencil: () => null,
  Search: () => null,
  SquareTerminal: () => null,
  Wrench: () => null,
}));

vi.mock("lucide-react-native", () => iconMocks);

import { resolveToolCallIcon } from "./tool-call-icon";

describe("tool-call-icon", () => {
  it("uses robot icon for task sub-agent details", () => {
    const icon = resolveToolCallIcon("Task", {
      type: "sub_agent",
      subAgentType: "Explore",
      description: "Inspect repository",
      log: "[Read] README.md",
      actions: [{ index: 1, toolName: "Read", summary: "README.md" }],
    });

    expect(icon).toBe(iconMocks.Bot);
  });

  it("uses robot icon for task calls without canonical detail", () => {
    const icon = resolveToolCallIcon("Task", {
      type: "unknown",
      input: null,
      output: null,
    });

    expect(icon).toBe(iconMocks.Bot);
    expect(resolveToolCallIcon("Task")).toBe(iconMocks.Bot);
  });

  it("keeps thinking icon override for unknown detail", () => {
    const icon = resolveToolCallIcon("thinking", {
      type: "unknown",
      input: null,
      output: null,
    });

    expect(icon).toBe(iconMocks.Brain);
  });
});
