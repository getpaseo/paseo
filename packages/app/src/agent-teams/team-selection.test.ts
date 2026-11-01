import { describe, expect, it } from "vitest";
import { FormPreferencesSchema } from "@/create-agent-preferences/preferences";
import {
  describeTeamRoles,
  rememberSelectedTeam,
  resolveSelectedTeam,
  setRoleModelOverride,
} from "./team-selection";

describe("team selection preferences", () => {
  it("remembers a team per host and resolves it while the host still defines it", () => {
    const preferences = rememberSelectedTeam({
      preferences: { provider: "claude" },
      serverId: "host-a",
      team: "full-stack",
    });
    expect(preferences).toEqual({ provider: "claude", teamByServer: { "host-a": "full-stack" } });
    expect(FormPreferencesSchema.parse(preferences)).toEqual(preferences);

    expect(
      resolveSelectedTeam({ preferences, serverId: "host-a", teamNames: ["full-stack"] }),
    ).toBe("full-stack");
    expect(
      resolveSelectedTeam({ preferences, serverId: "host-b", teamNames: ["full-stack"] }),
    ).toBeNull();
  });

  it("resolves to none when the remembered team is no longer defined", () => {
    const preferences = { teamByServer: { "host-a": "removed" } };
    expect(resolveSelectedTeam({ preferences, serverId: "host-a", teamNames: ["other"] })).toBe(
      null,
    );
    expect(resolveSelectedTeam({ preferences, serverId: null, teamNames: ["removed"] })).toBe(null);
  });

  it("forgets the team when None is chosen and keeps other hosts", () => {
    const preferences = {
      teamByServer: { "host-a": "full-stack", "host-b": "review" },
    };
    expect(rememberSelectedTeam({ preferences, serverId: "host-a", team: null })).toEqual({
      teamByServer: { "host-b": "review" },
    });
    expect(
      rememberSelectedTeam({
        preferences: { teamByServer: { "host-a": "full-stack" } },
        serverId: "host-a",
        team: null,
      }),
    ).toEqual({});
  });
});

describe("team role models", () => {
  it("describes each role with its provider and model, or the bare provider", () => {
    expect(
      describeTeamRoles([
        { name: "implementer", provider: "codex", model: "impl-model" },
        { name: "reviewer", provider: "claude" },
      ]),
    ).toBe("implementer (codex/impl-model), reviewer (claude)");
  });

  it("keeps only overrides that differ from the role's configured model", () => {
    const overrides = setRoleModelOverride({
      overrides: {},
      role: "implementer",
      model: "fast-model",
      configuredModel: "impl-model",
    });
    expect(overrides).toEqual({ implementer: "fast-model" });
    expect(
      setRoleModelOverride({
        overrides,
        role: "implementer",
        model: "impl-model",
        configuredModel: "impl-model",
      }),
    ).toEqual({});
    expect(
      setRoleModelOverride({
        overrides: { ...overrides, reviewer: "m" },
        role: "reviewer",
        model: null,
        configuredModel: undefined,
      }),
    ).toEqual({ implementer: "fast-model" });
  });
});
