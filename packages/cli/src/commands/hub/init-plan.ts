import path from "node:path";
import YAML from "yaml";
import type { HubStatus } from "./daemon-client.js";
import type { HubStarterAgentRuntime } from "./starter-agent-runtime.js";

export type HubInitProvider = "github" | "slack" | "discord";

export type HubInitConnectionResolution =
  | { kind: "connected"; daemonId: string }
  | { kind: "pending"; state: "connecting" | "reconnecting" }
  | { kind: "connect" }
  | { kind: "conflict"; origin: string };

export interface HubInitScaffoldInput {
  cwd: string;
  daemonSlug: string;
  agent: HubStarterAgentRuntime & { mode: string };
  provider: HubInitProvider;
  providerFilters: Readonly<Record<string, string>>;
}

export interface HubInitScaffold {
  triggerPath: string;
  trigger: string;
  testAction: string;
}

export function hubLoginResumeCommand(step: "connect" | "init", origin: string): string {
  return step === "connect" ? `paseo hub connect ${origin}` : "paseo hub init";
}

export function resolveHubInitConnection(
  status: HubStatus,
  origin: string,
): HubInitConnectionResolution {
  if (status.state === "connected" && status.hubOrigin === origin && status.daemonId !== null) {
    return { kind: "connected", daemonId: status.daemonId };
  }
  if (
    (status.state === "connecting" || status.state === "reconnecting") &&
    status.hubOrigin === origin
  ) {
    return { kind: "pending", state: status.state };
  }
  if (status.hubOrigin !== null && status.state !== "not_connected" && status.state !== "revoked") {
    return { kind: "conflict", origin: status.hubOrigin };
  }
  return { kind: "connect" };
}

export function createHubInitScaffold(input: HubInitScaffoldInput): HubInitScaffold {
  const provider = providerScaffold(input.provider, input.providerFilters);
  return {
    triggerPath: `.paseo/triggers/${input.provider}-help.yml`,
    trigger: YAML.stringify(
      triggerDocument({
        ...provider,
        target: { daemon: input.daemonSlug, cwd: path.resolve(input.cwd) },
        agent: {
          provider: input.agent.provider,
          model: input.agent.model,
          mode: input.agent.mode,
        },
      }),
      { lineWidth: 0 },
    ),
    testAction: provider.testAction,
  };
}

function providerScaffold(
  provider: HubInitProvider,
  filters: Readonly<Record<string, string>>,
): {
  name: string;
  event: string;
  connection: string;
  filters: object;
  reply?: "slack.reply" | "discord.reply";
  testAction: string;
} {
  const connection = requireFilter(filters, "connection");
  if (provider === "github") {
    const repo = requireFilter(filters, "repo");
    const user = requireFilter(filters, "user");
    return {
      name: "github-help",
      event: "github.issue_comment",
      connection,
      filters: { repo, contains: "@paseo", from_users: [user] },
      testAction: `Comment \`@paseo have a look\` on ${repo}.`,
    };
  }

  const user = requireFilter(filters, "user");
  if (provider === "slack") {
    return {
      name: "slack-help",
      event: "slack.mention",
      connection,
      filters: { from_users: [user] },
      reply: "slack.reply",
      testAction: "Mention `@Paseo have a look` in Slack.",
    };
  }

  return {
    name: "discord-help",
    event: "discord.mention",
    connection,
    filters: { from_users: [user] },
    reply: "discord.reply",
    testAction: "Mention `@Paseo have a look` in Discord.",
  };
}

function triggerDocument(input: {
  name: string;
  event: string;
  connection: string;
  filters: object;
  target: { daemon: string; cwd: string };
  agent: { provider: string; model: string; mode?: string };
  reply?: "slack.reply" | "discord.reply";
}): object {
  const replyInstruction = input.reply === undefined ? "" : "Answer with hub.reply, then ";
  return {
    name: input.name,
    enabled: true,
    on: { [input.event]: { connection: input.connection, filters: input.filters } },
    max_runtime: "2h",
    run: {
      target: input.target,
      agent: input.agent,
      continuation: { mode: "conversation" },
      max_runtime: "90m",
      idle_timeout: "10m",
      prompt: `${replyInstruction}complete this request and call hub.finish_execution when done.\n\n<user-prompt>\n\${{ paseo.prompt }}\n</user-prompt>\n`,
      ...(input.reply === undefined
        ? {}
        : { outputs: { [input.reply]: { max: 1, required: true } } }),
    },
  };
}

function requireFilter(filters: Readonly<Record<string, string>>, name: string): string {
  const value = filters[name]?.trim();
  if (!value) throw new Error(`${name} is required for this provider`);
  return value;
}
