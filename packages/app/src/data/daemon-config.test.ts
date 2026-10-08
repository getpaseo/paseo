import { expect, test } from "vitest";
import { scopeDaemonConfigPatch } from "./daemon-config";

test("profile settings writes carry the displayed profile identity", () => {
  expect(
    scopeDaemonConfigPatch({
      settingsProfileId: "coding",
      patch: {
        appendSystemPrompt: "Coding instructions",
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: true },
        enableTerminalAgentHooks: true,
      },
    }),
  ).toEqual({
    enableTerminalAgentHooks: true,
    agentSettingsProfilePatch: {
      profileId: "coding",
      appendSystemPrompt: "Coding instructions",
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: true },
    },
  });
});

test("explicit profile writes and hosts without profiles keep their request shape", () => {
  const patch = { appendSystemPrompt: "Shared instructions" };
  expect(scopeDaemonConfigPatch({ patch })).toEqual(patch);
  const scoped = { agentSettingsProfilePatch: { profileId: "reverse", agentProfiles: [] } };
  expect(scopeDaemonConfigPatch({ settingsProfileId: "coding", patch: scoped })).toEqual(scoped);
});
