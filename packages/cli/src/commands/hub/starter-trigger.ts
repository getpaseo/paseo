import type { HubSetupResources } from "./hub-client/index.js";
import type { HubInitProvider } from "./init-plan.js";

export interface HubStarterTriggerConnection {
  id: string;
  label: string;
  provider: HubInitProvider;
  filters: Readonly<Record<string, string>>;
}

export function availableStarterTriggerConnections(
  resources: HubSetupResources,
  githubRepository?: string,
): HubStarterTriggerConnection[] {
  return [
    ...(githubRepository !== undefined &&
    resources.github.some(({ repositories }) => repositories.includes(githubRepository))
      ? [
          {
            id: `github:${githubRepository}`,
            label: `GitHub — ${githubRepository}`,
            provider: "github" as const,
            filters: { repo: githubRepository },
          },
        ]
      : []),
    ...resources.slack.map(({ teamId, teamName }) => ({
      id: `slack:${teamId}`,
      label: `Slack — ${teamName}`,
      provider: "slack" as const,
      filters: { workspace: teamId },
    })),
    ...resources.discord.map(({ guildId, guildName }) => ({
      id: `discord:${guildId}`,
      label: `Discord — ${guildName}`,
      provider: "discord" as const,
      filters: { guild: guildId },
    })),
  ];
}
