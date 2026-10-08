import { describe, expect, test } from "vitest";
import { createAgentProfilesPatch } from "./use-agent-profiles";

describe("createAgentProfilesPatch", () => {
  test("targets only the selected settings profile", () => {
    const agentProfiles = [{ id: "coding", name: "Coding", provider: "codex" }];

    expect(
      createAgentProfilesPatch({
        settingsProfileId: "settings-coding",
        activeSettingsProfileId: "settings-reverse",
        agentProfiles,
      }),
    ).toEqual({
      agentSettingsProfilePatch: { profileId: "settings-coding", agentProfiles },
    });
  });

  test("targets the settings profile that was active when the presets were displayed", () => {
    const agentProfiles = [{ id: "coding", name: "Coding", provider: "codex" }];

    expect(
      createAgentProfilesPatch({
        settingsProfileId: undefined,
        activeSettingsProfileId: "settings-coding",
        agentProfiles,
      }),
    ).toEqual({
      agentSettingsProfilePatch: {
        profileId: "settings-coding",
        agentProfiles,
      },
    });
  });

  test("keeps the shared preset patch for hosts without settings profiles", () => {
    const agentProfiles = [{ id: "coding", name: "Coding", provider: "codex" }];

    expect(
      createAgentProfilesPatch({
        settingsProfileId: undefined,
        activeSettingsProfileId: undefined,
        agentProfiles,
      }),
    ).toEqual({ agentProfiles });
  });
});
