import path from "node:path";
import YAML from "yaml";
import type { HubProject } from "./hub-client/index.js";
import type { HubStatus } from "./daemon-client.js";

export type HubInitProvider = "github" | "slack" | "discord";

export type HubInitProjectResolution =
  | { kind: "none" }
  | { kind: "selected"; project: HubProject }
  | { kind: "choose"; projects: readonly HubProject[] };

export type HubInitConnectionResolution =
  | { kind: "connected"; daemonId: string }
  | { kind: "connect" }
  | { kind: "conflict"; origin: string };

export type HubInitOpeningPlan =
  | { kind: "refuse-existing"; path: string }
  | { kind: "continue"; steps: readonly ("login" | "connect" | "project" | "scaffold")[] };

export interface HubInitScaffoldInput {
  cwd: string;
  daemonSlug: string;
  provider: HubInitProvider;
  providerFilters: Readonly<Record<string, string>>;
}

export interface HubInitScaffold {
  hub: string;
  workflowPath: string;
  workflow: string;
  testAction: string;
}

export function planHubInitOpening(input: {
  loggedIn: boolean;
  paseoDirectoryExists: boolean;
  cwd: string;
}): HubInitOpeningPlan {
  if (input.paseoDirectoryExists) {
    return { kind: "refuse-existing", path: path.join(input.cwd, ".paseo") };
  }
  return {
    kind: "continue",
    steps: [...(input.loggedIn ? [] : (["login"] as const)), "connect", "project", "scaffold"],
  };
}

export function resolveHubInitProjects(projects: readonly HubProject[]): HubInitProjectResolution {
  if (projects.length === 0) return { kind: "none" };
  if (projects.length === 1) return { kind: "selected", project: projects[0]! };
  return { kind: "choose", projects };
}

export function resolveHubInitConnection(
  status: HubStatus,
  origin: string,
): HubInitConnectionResolution {
  const relationshipIsUsable = ["connecting", "connected", "reconnecting"].includes(status.state);
  if (relationshipIsUsable && status.hubOrigin === origin && status.daemonId !== null) {
    return { kind: "connected", daemonId: status.daemonId };
  }
  if (status.hubOrigin !== null && status.state !== "not_connected" && status.state !== "revoked") {
    return { kind: "conflict", origin: status.hubOrigin };
  }
  return { kind: "connect" };
}

export function createHubInitScaffold(input: HubInitScaffoldInput): HubInitScaffold {
  const environmentName = input.daemonSlug;
  const hub = YAML.stringify(
    {
      environments: {
        [environmentName]: {
          kind: "daemon",
          daemon: input.daemonSlug,
          cwd: path.resolve(input.cwd),
        },
      },
      agents: {
        codex: {
          provider: "codex",
          mode: "full-access",
        },
      },
    },
    { lineWidth: 0 },
  );
  const provider = providerScaffold(input.provider, input.providerFilters, environmentName);
  return {
    hub,
    workflowPath: `.paseo/workflows/${input.provider}-help.yml`,
    workflow: YAML.stringify(provider.workflow, { lineWidth: 0 }),
    testAction: provider.testAction,
  };
}

function providerScaffold(
  provider: HubInitProvider,
  filters: Readonly<Record<string, string>>,
  environment: string,
): { workflow: object; testAction: string } {
  if (provider === "github") {
    const repo = requireFilter(filters, "repo");
    const user = requireFilter(filters, "user");
    return {
      workflow: workflow({
        name: "github-help",
        on: "github.issue_comment",
        filters: { repo, contains: "@paseo", from_users: [user] },
        environment,
      }),
      testAction: `Comment \`@paseo have a look\` on ${repo}.`,
    };
  }

  const user = requireFilter(filters, "user");
  const channel = requireFilter(filters, "channel");
  if (provider === "slack") {
    const workspace = requireFilter(filters, "workspace");
    return {
      workflow: workflow({
        name: "slack-help",
        on: "slack.mention",
        filters: { workspace, channels: [channel], from_users: [user] },
        environment,
        reply: "slack.reply",
      }),
      testAction: `Mention \`@Paseo have a look\` in Slack channel ${channel}.`,
    };
  }

  const guild = requireFilter(filters, "guild");
  return {
    workflow: workflow({
      name: "discord-help",
      on: "discord.mention",
      filters: { guild, channels: [channel], from_users: [user] },
      environment,
      reply: "discord.reply",
    }),
    testAction: `Mention \`@Paseo have a look\` in Discord channel ${channel}.`,
  };
}

function workflow(input: {
  name: string;
  on: string;
  filters: object;
  environment: string;
  reply?: "slack.reply" | "discord.reply";
}): object {
  const replyInstruction = input.reply === undefined ? "" : "Answer with hub.reply, then ";
  return {
    name: input.name,
    on: input.on,
    max_runtime: "2h",
    filters: input.filters,
    steps: [
      {
        id: "work",
        environment: input.environment,
        max_runtime: "90m",
        idle_timeout: "10m",
        agent: "codex",
        prompt: [
          {
            text: `${replyInstruction}complete this request and call hub.finish_execution when done.\n\n<user-prompt>\n\${{ paseo.prompt }}\n</user-prompt>\n`,
          },
        ],
        ...(input.reply === undefined
          ? {}
          : { allow_outputs: [{ type: input.reply, max: 1, required: true }] }),
      },
    ],
  };
}

function requireFilter(filters: Readonly<Record<string, string>>, name: string): string {
  const value = filters[name]?.trim();
  if (!value) throw new Error(`${name} is required for this provider`);
  return value;
}
