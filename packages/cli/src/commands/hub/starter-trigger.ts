import type { HubConfigurationResources } from "./hub-client/index.js";
import type { HubInitProvider } from "./init-plan.js";

export interface HubStarterTriggerConnection {
  id: string;
  label: string;
  provider: HubInitProvider;
  filters: Readonly<Record<string, string>>;
}

export function availableStarterTriggerConnections(
  resources: HubConfigurationResources,
  githubRepository?: string,
): HubStarterTriggerConnection[] {
  return [
    ...resources.github.flatMap((connection) =>
      githubRepository !== undefined && connection.repositories.includes(githubRepository)
        ? [
            {
              id: `github:${githubRepository}`,
              label: `GitHub — ${githubRepository}`,
              provider: "github" as const,
              filters: {
                connection: connection.slug,
                repo: githubRepository,
              },
            },
          ]
        : [],
    ),
    ...resources.slack.map(({ slug, teamName }) => ({
      id: `slack:${slug}`,
      label: `Slack — ${teamName}`,
      provider: "slack" as const,
      filters: { connection: slug },
    })),
    ...resources.discord.map(({ slug, guildName }) => ({
      id: `discord:${slug}`,
      label: `Discord — ${guildName}`,
      provider: "discord" as const,
      filters: { connection: slug },
    })),
  ];
}
