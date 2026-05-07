import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceAgentDefaults,
  resolveWorkspaceScopedFormPreferences,
} from "./use-agent-form-state";

describe("workspace-scoped agent form preferences", () => {
  it("selects defaults for the requested workspace key only", () => {
    expect(
      resolveWorkspaceAgentDefaults({
        workspaceDefaultsKey: "workspace-a",
        preferences: {
          workspaceAgentDefaults: {
            "workspace-a": {
              provider: "codex",
              model: "gpt-5.4",
            },
            "workspace-b": {
              provider: "claude",
              model: "claude-sonnet-4-6",
            },
          },
        },
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
  });

  it("uses global preferences when no workspace defaults exist", () => {
    const preferences = {
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-sonnet-4-6",
          mode: "plan",
        },
      },
    };

    expect(
      resolveWorkspaceScopedFormPreferences({
        preferences,
        workspaceDefaults: null,
      }),
    ).toBe(preferences);
  });

  it("uses workspace defaults instead of global provider preferences when present", () => {
    expect(
      resolveWorkspaceScopedFormPreferences({
        preferences: {
          provider: "claude",
          providerPreferences: {
            claude: {
              model: "claude-sonnet-4-6",
              mode: "plan",
            },
            codex: {
              model: "gpt-5.3-codex",
              mode: "full-access",
            },
          },
          favoriteModels: [{ provider: "claude", modelId: "claude-sonnet-4-6" }],
        },
        workspaceDefaults: {
          provider: "codex",
          model: "gpt-5.4",
          modeId: "auto",
          thinkingOptionId: "high",
          featureValues: {
            webSearch: true,
          },
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          mode: "auto",
          thinkingByModel: {
            "gpt-5.4": "high",
          },
          featureValues: {
            webSearch: true,
          },
        },
      },
      favoriteModels: [{ provider: "claude", modelId: "claude-sonnet-4-6" }],
    });
  });
});
