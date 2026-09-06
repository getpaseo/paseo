import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveVoiceOrchestratorSelection } from "./voice-settings-model";

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "codex",
    enabled: true,
    status: "ready",
    defaultModeId: "auto-review",
    modes: [
      { id: "auto-review", label: "Agent" },
      { id: "full-access", label: "Full access" },
    ],
    models: [
      {
        provider: "codex",
        id: "gpt-5.4",
        label: "GPT-5.4",
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ],
  },
];

describe("voice orchestrator settings", () => {
  it("always resolves an explicit provider mode with a model selection", () => {
    expect(
      resolveVoiceOrchestratorSelection({
        entries,
        current: undefined,
        provider: "codex",
        model: "gpt-5.4",
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      modeId: "auto-review",
      thinkingOptionId: "high",
    });
  });

  it("preserves an explicitly selected valid mode", () => {
    expect(
      resolveVoiceOrchestratorSelection({
        entries,
        current: {
          provider: "codex",
          model: "gpt-5.4",
          modeId: "full-access",
          thinkingOptionId: "medium",
        },
        provider: "codex",
        model: "gpt-5.4",
      }),
    ).toMatchObject({ modeId: "full-access", thinkingOptionId: "medium" });
  });

  it("rejects providers that cannot supply a mode", () => {
    expect(
      resolveVoiceOrchestratorSelection({
        entries: [{ provider: "pi", enabled: true, status: "ready", modes: [] }],
        current: undefined,
        provider: "pi",
        model: "",
      }),
    ).toBeNull();
  });
});
