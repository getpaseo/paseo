import { describe, expect, it } from "vitest";
import { availableStarterTriggerConnections } from "./starter-trigger.js";

describe("starter trigger connections", () => {
  it("returns only concrete connections that can back the generated workflow", () => {
    expect(
      availableStarterTriggerConnections(
        {
          github: [
            {
              slug: "github-getpaseo",
              accountLogin: "getpaseo",
              accountType: "Organization",
              repositories: ["getpaseo/paseo"],
            },
          ],
          slack: [{ teamId: "T123", teamName: "Paseo" }],
          discord: [{ guildId: "456", guildName: "Paseo Discord" }],
        },
        "getpaseo/paseo",
      ),
    ).toEqual([
      {
        id: "github:getpaseo/paseo",
        label: "GitHub — getpaseo/paseo",
        provider: "github",
        filters: { repo: "getpaseo/paseo" },
      },
      {
        id: "slack:T123",
        label: "Slack — Paseo",
        provider: "slack",
        filters: { workspace: "T123" },
      },
      {
        id: "discord:456",
        label: "Discord — Paseo Discord",
        provider: "discord",
        filters: { guild: "456" },
      },
    ]);
  });

  it("does not offer GitHub when the current repository is not connected", () => {
    expect(
      availableStarterTriggerConnections(
        {
          github: [
            {
              slug: "github-getpaseo",
              accountLogin: "getpaseo",
              accountType: "Organization",
              repositories: ["getpaseo/hub"],
            },
          ],
          slack: [],
          discord: [],
        },
        "getpaseo/paseo",
      ),
    ).toEqual([]);
  });
});
