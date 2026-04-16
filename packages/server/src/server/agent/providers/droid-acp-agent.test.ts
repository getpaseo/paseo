import { describe, expect, test } from "vitest";

import { buildDroidDefaultCommand, parseDroidExecHelpReasoningMap } from "./droid-acp-agent.js";

describe("parseDroidExecHelpReasoningMap", () => {
  test("extracts supported reasoning efforts and defaults from droid exec help", () => {
    const reasoning = parseDroidExecHelpReasoningMap(`
Usage: droid exec [options] [prompt...]

Model details:
  - GPT-5.4: supports reasoning: Yes; supported: [low, medium, high, xhigh]; default: medium
  - DeepSeek R1 0528: supports reasoning: No; supported: [none]; default: none
`);

    expect(reasoning.get("GPT-5.4")).toEqual({
      defaultThinkingOptionId: "medium",
      thinkingOptions: [
        { id: "low", label: "low", isDefault: false },
        { id: "medium", label: "medium", isDefault: true },
        { id: "high", label: "high", isDefault: false },
        { id: "xhigh", label: "xhigh", isDefault: false },
      ],
    });
    expect(reasoning.get("DeepSeek R1 0528")).toEqual({
      defaultThinkingOptionId: "none",
      thinkingOptions: [{ id: "none", label: "none", isDefault: true }],
    });
  });
});

describe("buildDroidDefaultCommand", () => {
  test("adds mode, model, and reasoning flags for a new session", () => {
    expect(
      buildDroidDefaultCommand(["droid", "exec", "--output-format", "acp"], {
        modeId: "spec",
        model: "gpt-5.4-mini",
        thinkingOptionId: "xhigh",
      }),
    ).toEqual([
      "droid",
      "exec",
      "--output-format",
      "acp",
      "--use-spec",
      "--model",
      "gpt-5.4-mini",
      "--reasoning-effort",
      "xhigh",
    ]);
  });
});
