import { describe, expect, it } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { resolveVoiceFeatureUiEnabled } from "@/hooks/voice-feature-ui-enabled";

function makeConfig(
  overrides: Partial<Pick<MutableDaemonConfig, "dictation" | "voiceMode">> = {},
): MutableDaemonConfig {
  return {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    dictation: { enabled: false },
    voiceMode: { enabled: true },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    ...overrides,
  };
}

describe("resolveVoiceFeatureUiEnabled", () => {
  it("hides when daemon config disables the feature even if capability is still on", () => {
    expect(
      resolveVoiceFeatureUiEnabled({
        config: makeConfig({ dictation: { enabled: false }, voiceMode: { enabled: true } }),
        serverInfo: {
          serverId: "srv",
          hostname: "host",
          version: "1",
          capabilities: {
            voice: {
              dictation: { enabled: true, reason: "" },
              voice: { enabled: true, reason: "" },
            },
          },
        },
        mode: "dictation",
      }),
    ).toBe(false);
  });

  it("hides when config is null so composer does not flash before daemon config arrives", () => {
    expect(
      resolveVoiceFeatureUiEnabled({
        config: null,
        serverInfo: {
          serverId: "srv",
          hostname: "host",
          version: "1",
          capabilities: {
            voice: {
              dictation: { enabled: false, reason: "Dictation is disabled in daemon config." },
              voice: { enabled: true, reason: "" },
            },
          },
        },
        mode: "dictation",
      }),
    ).toBe(false);
  });

  it("hides when config and capability are both absent", () => {
    expect(
      resolveVoiceFeatureUiEnabled({
        config: null,
        serverInfo: null,
        mode: "voice",
      }),
    ).toBe(false);
  });

  it("shows when config enables the feature and capability is on or absent", () => {
    expect(
      resolveVoiceFeatureUiEnabled({
        config: makeConfig({ voiceMode: { enabled: true } }),
        serverInfo: null,
        mode: "voice",
      }),
    ).toBe(true);

    expect(
      resolveVoiceFeatureUiEnabled({
        config: makeConfig({ voiceMode: { enabled: true } }),
        serverInfo: {
          serverId: "srv",
          hostname: "host",
          version: "1",
          capabilities: {
            voice: {
              dictation: { enabled: false, reason: "" },
              voice: { enabled: true, reason: "" },
            },
          },
        },
        mode: "voice",
      }),
    ).toBe(true);
  });

  it("hides when capability reports disabled after config enables", () => {
    expect(
      resolveVoiceFeatureUiEnabled({
        config: makeConfig({ dictation: { enabled: true } }),
        serverInfo: {
          serverId: "srv",
          hostname: "host",
          version: "1",
          capabilities: {
            voice: {
              dictation: { enabled: false, reason: "Dictation is disabled in daemon config." },
              voice: { enabled: true, reason: "" },
            },
          },
        },
        mode: "dictation",
      }),
    ).toBe(false);
  });
});
