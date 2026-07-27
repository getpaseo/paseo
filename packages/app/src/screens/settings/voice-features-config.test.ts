import { describe, expect, it } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import {
  createVoiceFeaturePatch,
  getVoiceFeaturesCardState,
  getVoiceFeaturesMutationViewState,
} from "./voice-features-config";

function makeConfig(
  overrides: Partial<Pick<MutableDaemonConfig, "dictation" | "voiceMode">> = {},
): MutableDaemonConfig {
  return {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    dictation: { enabled: true },
    voiceMode: { enabled: true },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    ...overrides,
  };
}

describe("getVoiceFeaturesCardState", () => {
  it("is hidden when disconnected", () => {
    expect(getVoiceFeaturesCardState({ isConnected: false, config: makeConfig() }).isVisible).toBe(
      false,
    );
  });

  it("defaults both features off when config is null", () => {
    expect(getVoiceFeaturesCardState({ isConnected: true, config: null })).toEqual({
      isVisible: true,
      rows: [
        { id: "dictation", isEnabled: false },
        { id: "voiceMode", isEnabled: false },
      ],
    });
  });

  it("reads enabled flags from config", () => {
    expect(
      getVoiceFeaturesCardState({
        isConnected: true,
        config: makeConfig({
          dictation: { enabled: false },
          voiceMode: { enabled: true },
        }),
      }).rows,
    ).toEqual([
      { id: "dictation", isEnabled: false },
      { id: "voiceMode", isEnabled: true },
    ]);
  });
});

describe("createVoiceFeaturePatch", () => {
  it("patches a single feature", () => {
    expect(createVoiceFeaturePatch("dictation", false)).toEqual({
      dictation: { enabled: false },
    });
    expect(createVoiceFeaturePatch("voiceMode", true)).toEqual({
      voiceMode: { enabled: true },
    });
  });
});

describe("getVoiceFeaturesMutationViewState", () => {
  it("surfaces pending and error text", () => {
    expect(
      getVoiceFeaturesMutationViewState({
        isPending: true,
        error: null,
        updatingLabel: "Updating…",
      }),
    ).toEqual({
      isSwitchDisabled: true,
      loadingText: "Updating…",
      errorText: null,
    });
    expect(
      getVoiceFeaturesMutationViewState({
        isPending: false,
        error: new Error("boom"),
        updatingLabel: "Updating…",
      }).errorText,
    ).toBe("boom");
  });
});
