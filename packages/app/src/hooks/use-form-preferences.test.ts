import { describe, expect, it } from "vitest";

import {
  buildWorkspaceAgentDefaultsKey,
  buildFavoriteModelKey,
  isFavoriteModel,
  mergeProviderPreferences,
  mergeWorkspaceAgentDefaults,
  toggleFavoriteModel,
} from "./use-form-preferences";

describe("mergeProviderPreferences", () => {
  it("stores the selected model for a provider", () => {
    expect(
      mergeProviderPreferences({
        preferences: {},
        provider: "claude",
        updates: { model: "claude-opus-4-6" },
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-opus-4-6",
        },
      },
    });
  });

  it("merges thinking preferences by model without dropping existing entries", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "claude",
          providerPreferences: {
            claude: {
              model: "claude-sonnet-4-6",
              thinkingByModel: {
                "claude-sonnet-4-6": "medium",
              },
            },
          },
        },
        provider: "claude",
        updates: {
          thinkingByModel: {
            "claude-opus-4-6": "high",
          },
        },
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-sonnet-4-6",
          thinkingByModel: {
            "claude-sonnet-4-6": "medium",
            "claude-opus-4-6": "high",
          },
        },
      },
    });
  });

  it("merges feature values without dropping existing entries", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.4",
              featureValues: {
                fast_mode: true,
              },
            },
          },
        },
        provider: "codex",
        updates: {
          featureValues: {
            plan_mode: true,
          },
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          featureValues: {
            fast_mode: true,
            plan_mode: true,
          },
        },
      },
    });
  });
});

describe("workspace agent defaults", () => {
  it("builds a stable key from server and workspace ids", () => {
    expect(
      buildWorkspaceAgentDefaultsKey({
        serverId: "host-1",
        workspaceId: "/repo/worktree-a",
      }),
    ).toBe('["host-1","/repo/worktree-a"]');
  });

  it("stores workspace-scoped defaults without dropping global preferences", () => {
    expect(
      mergeWorkspaceAgentDefaults({
        preferences: {
          provider: "claude",
          providerPreferences: {
            claude: {
              model: "claude-sonnet-4-6",
            },
          },
          favoriteModels: [{ provider: "codex", modelId: "gpt-5.4" }],
        },
        workspaceKey: "workspace-a",
        updates: {
          provider: "codex",
          model: "gpt-5.4",
          modeId: "auto",
          thinkingOptionId: "high",
        },
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-sonnet-4-6",
        },
      },
      favoriteModels: [{ provider: "codex", modelId: "gpt-5.4" }],
      workspaceAgentDefaults: {
        "workspace-a": {
          provider: "codex",
          model: "gpt-5.4",
          modeId: "auto",
          thinkingOptionId: "high",
        },
      },
    });
  });

  it("merges feature defaults for one workspace without touching another", () => {
    expect(
      mergeWorkspaceAgentDefaults({
        preferences: {
          workspaceAgentDefaults: {
            "workspace-a": {
              provider: "codex",
              featureValues: { webSearch: true },
            },
            "workspace-b": {
              provider: "claude",
              featureValues: { plan: true },
            },
          },
        },
        workspaceKey: "workspace-a",
        updates: {
          featureValues: { webSearch: false, networkAccess: true },
        },
      }),
    ).toEqual({
      workspaceAgentDefaults: {
        "workspace-a": {
          provider: "codex",
          featureValues: { webSearch: false, networkAccess: true },
        },
        "workspace-b": {
          provider: "claude",
          featureValues: { plan: true },
        },
      },
    });
  });

  it("clears provider-specific defaults when the workspace provider changes", () => {
    expect(
      mergeWorkspaceAgentDefaults({
        preferences: {
          workspaceAgentDefaults: {
            "workspace-a": {
              provider: "codex",
              model: "gpt-5.4",
              modeId: "auto",
              thinkingOptionId: "high",
              featureValues: { webSearch: true },
            },
          },
        },
        workspaceKey: "workspace-a",
        updates: {
          provider: "claude",
        },
      }),
    ).toEqual({
      workspaceAgentDefaults: {
        "workspace-a": {
          provider: "claude",
        },
      },
    });
  });
});

describe("favorite model preferences", () => {
  it("builds a stable favorite key from provider and model", () => {
    expect(buildFavoriteModelKey({ provider: "claude", modelId: "sonnet-4.6" })).toBe(
      "claude:sonnet-4.6",
    );
  });

  it("adds a model to favorites without dropping other preferences", () => {
    expect(
      toggleFavoriteModel({
        preferences: {
          provider: "claude",
          providerPreferences: {
            claude: {
              model: "claude-sonnet-4-6",
            },
          },
        },
        provider: "codex",
        modelId: "gpt-5.4",
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-sonnet-4-6",
        },
      },
      favoriteModels: [
        {
          provider: "codex",
          modelId: "gpt-5.4",
        },
      ],
    });
  });

  it("removes a model from favorites when toggled again", () => {
    expect(
      toggleFavoriteModel({
        preferences: {
          favoriteModels: [
            {
              provider: "codex",
              modelId: "gpt-5.4",
            },
          ],
        },
        provider: "codex",
        modelId: "gpt-5.4",
      }),
    ).toEqual({
      favoriteModels: [],
    });
  });

  it("reports whether a model is favorited", () => {
    expect(
      isFavoriteModel({
        preferences: {
          favoriteModels: [
            {
              provider: "codex",
              modelId: "gpt-5.4",
            },
          ],
        },
        provider: "codex",
        modelId: "gpt-5.4",
      }),
    ).toBe(true);

    expect(
      isFavoriteModel({
        preferences: {
          favoriteModels: [
            {
              provider: "codex",
              modelId: "gpt-5.4",
            },
          ],
        },
        provider: "claude",
        modelId: "sonnet-4.6",
      }),
    ).toBe(false);
  });
});
