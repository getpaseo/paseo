import { describe, expect, test } from "vitest";

import { buildACPSessionProcessArgs } from "./acp-agent.js";
import { buildGrokSessionLaunchArgs, transformGrokModelDefinition } from "./grok-acp-agent.js";

describe("GrokACPAgentClient", () => {
  test("maps Grok model metadata into context and thinking controls", () => {
    const model = transformGrokModelDefinition(
      {
        modelId: "grok-4.5",
        name: "Grok 4.5",
        _meta: {
          totalContextTokens: 500_000,
          reasoningEffort: "high",
          reasoningEfforts: [
            { id: "high", label: "High" },
            { id: "medium", label: "Medium" },
          ],
        },
      },
      { provider: "acp", id: "grok-4.5", label: "Grok 4.5", isDefault: true },
    );

    expect(model).toMatchObject({
      contextWindowMaxTokens: 500_000,
      defaultThinkingOptionId: "high",
      thinkingOptions: [
        { id: "high", isDefault: true },
        { id: "medium", isDefault: false },
      ],
    });
  });

  test("launches Grok with the selected model, effort, and unattended mode", () => {
    const sessionArgs = buildGrokSessionLaunchArgs({
      provider: "acp",
      cwd: "/workspace/paseo",
      model: "grok-4.5",
      thinkingOptionId: "high",
      modeId: "full-access",
    });

    expect(sessionArgs).toEqual([
      "--model",
      "grok-4.5",
      "--reasoning-effort",
      "high",
      "--sandbox",
      "devbox",
      "--permission-mode",
      "bypassPermissions",
      "--rules",
      expect.stringContaining("without asking follow-up questions"),
    ]);
    expect(
      buildACPSessionProcessArgs({
        prefixArgs: [],
        defaultArgs: ["agent", "stdio"],
        sessionArgs,
        placement: "before-default-args",
      }),
    ).toEqual([...sessionArgs, "agent", "stdio"]);
  });

  test("uses Grok's native plan mode", () => {
    expect(
      buildGrokSessionLaunchArgs({
        provider: "acp",
        cwd: "/workspace/paseo",
        modeId: "plan",
      }),
    ).toEqual(["--permission-mode", "plan"]);
  });
});
