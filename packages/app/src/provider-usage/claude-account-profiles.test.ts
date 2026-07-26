import { describe, expect, it } from "vitest";
import {
  buildClaudeAccountPatch,
  isAbsoluteHostPath,
  listClaudeAccountProfiles,
} from "./claude-account-profiles";

describe("Claude account profiles", () => {
  it("lists Claude providers backed by separate config directories", () => {
    expect(
      listClaudeAccountProfiles({
        mcp: { injectIntoAgents: true },
        browserTools: { enabled: false },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        providers: {
          "claude-work": {
            extends: "claude",
            label: "Work",
            env: { CLAUDE_CONFIG_DIR: "/accounts/work" },
          },
          "claude-api": {
            extends: "claude",
            label: "API",
            env: { ANTHROPIC_API_KEY: "secret" },
          },
        },
      }),
    ).toEqual([
      {
        providerId: "claude-work",
        label: "Work",
        configDir: "/accounts/work",
      },
    ]);
  });

  it("builds a selectable Claude provider and allocates a stable unique id", () => {
    expect(
      buildClaudeAccountPatch({
        label: "Work Account",
        configDir: "/accounts/work",
        existingProviderIds: ["claude-work-account"],
      }),
    ).toEqual({
      providers: {
        "claude-work-account-2": {
          extends: "claude",
          label: "Work Account",
          description: "Claude account using /accounts/work",
          env: { CLAUDE_CONFIG_DIR: "/accounts/work" },
          params: { paseoClaudeAccount: true },
          enabled: true,
        },
      },
    });
  });

  it("accepts POSIX, Windows drive, and UNC absolute host paths", () => {
    expect(isAbsoluteHostPath("/accounts/work")).toBe(true);
    expect(isAbsoluteHostPath("C:\\accounts\\work")).toBe(true);
    expect(isAbsoluteHostPath("\\\\server\\accounts\\work")).toBe(true);
    expect(isAbsoluteHostPath(".claude-work")).toBe(false);
  });
});
