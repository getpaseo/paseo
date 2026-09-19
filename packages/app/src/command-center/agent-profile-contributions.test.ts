import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import {
  buildAgentProfileCommandCenterContributions,
  type AgentProfileCommandCenterSource,
} from "./agent-profile-contributions";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "profile-1",
    name: "UI work",
    provider: "claude-code",
    ...overrides,
  };
}

function source(overrides: Partial<AgentProfileCommandCenterSource> = {}): {
  value: AgentProfileCommandCenterSource;
  started: string[];
  opened: string[];
  managed: string[];
} {
  const started: string[] = [];
  const opened: string[] = [];
  const managed: string[] = [];
  return {
    started,
    opened,
    managed,
    value: {
      serverId: "host-1",
      hosts: [{ serverId: "host-1", label: "Local" }],
      profiles: [profile()],
      isSupported: true,
      labels: {
        section: "Actions",
        manageProfiles: "Manage agent profiles",
        manageProfilesForHost: (hostLabel) => `Agent profiles (${hostLabel})`,
      },
      icons: {},
      startAgentWithProfile: (profileId) => started.push(profileId),
      openAgentProfiles: () => {
        managed.push("manage");
      },
      openHostAgentProfiles: (serverId) => opened.push(serverId),
      ...overrides,
    },
  };
}

describe("agent profile command center contributions", () => {
  it("lists one start entry per profile plus a manage entry", () => {
    const fixture = source({
      profiles: [
        profile({ id: "a", name: "UI work", provider: "claude-code", model: "opus" }),
        profile({ id: "b", name: "Backend", provider: "codex" }),
      ],
    });

    const contributions = buildAgentProfileCommandCenterContributions(fixture.value);

    expect(contributions.map((entry) => entry.id)).toEqual([
      "agent-profile:start:a",
      "agent-profile:start:b",
      "agent-profile:manage",
    ]);
    expect(contributions[0]?.presentation).toMatchObject({
      kind: "action",
      title: "UI work",
      sectionTitle: "Actions",
    });
    expect(contributions[0]?.keywords).toEqual(
      expect.arrayContaining(["agent", "profile", "UI work", "claude-code", "opus"]),
    );
    expect(contributions[2]?.presentation).toMatchObject({
      kind: "action",
      title: "Manage agent profiles",
    });
  });

  it("runs the start and manage callbacks", () => {
    const fixture = source();
    const contributions = buildAgentProfileCommandCenterContributions(fixture.value);

    contributions[0]?.run();
    contributions[1]?.run();

    expect(fixture.started).toEqual(["profile-1"]);
    expect(fixture.managed).toEqual(["manage"]);
  });

  it("shows only the manage entry when the host has no profiles yet", () => {
    const fixture = source({ profiles: [] });

    const contributions = buildAgentProfileCommandCenterContributions(fixture.value);

    expect(contributions.map((entry) => entry.id)).toEqual(["agent-profile:manage"]);
  });

  it("omits the group while profiles load or on legacy daemons", () => {
    expect(buildAgentProfileCommandCenterContributions(source({ profiles: null }).value)).toEqual(
      [],
    );
    expect(
      buildAgentProfileCommandCenterContributions(source({ isSupported: false }).value),
    ).toEqual([]);
  });

  it("offers one manage entry per host when no host is selected", () => {
    const fixture = source({
      serverId: null,
      profiles: null,
      isSupported: false,
      hosts: [
        { serverId: "host-1", label: "Local" },
        { serverId: "host-2", label: "Remote" },
      ],
    });

    const contributions = buildAgentProfileCommandCenterContributions(fixture.value);

    expect(contributions.map((entry) => entry.id)).toEqual([
      "agent-profile:manage:host-1",
      "agent-profile:manage:host-2",
    ]);
    expect(contributions[1]?.presentation).toMatchObject({
      kind: "action",
      title: "Agent profiles (Remote)",
    });

    contributions[1]?.run();
    expect(fixture.opened).toEqual(["host-2"]);
  });

  it("offers nothing without hosts", () => {
    expect(buildAgentProfileCommandCenterContributions(source({ hosts: [] }).value)).toEqual([]);
  });
});
