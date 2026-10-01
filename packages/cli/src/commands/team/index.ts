import { Command, InvalidArgumentError } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  TeamSummary,
  TeamEventsResponseMessage,
  TeamEventPayload,
  TeamMessageResponseMessage,
} from "@getpaseo/protocol/messages";
import {
  withOutput,
  type CommandOptions,
  type ListResult,
  type SingleResult,
  type OutputSchema,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

type TeamEventsPayload = TeamEventsResponseMessage["payload"];
type TeamMessagePayload = TeamMessageResponseMessage["payload"];

const teamSchema: OutputSchema<TeamSummary> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id" },
    { header: "TITLE", field: "title" },
    { header: "STATUS", field: "status" },
    {
      header: "ITEMS",
      field: (team) => team.items.map((item) => `${item.title} [${item.phase}]`).join(", "),
    },
  ],
};

const inspectSchema: OutputSchema<TeamEventsPayload> = {
  idField: "teamId",
  columns: [
    { header: "ID", field: "teamId" },
    { header: "TITLE", field: (snapshot) => snapshot.team.title },
    { header: "STATUS", field: (snapshot) => snapshot.team.status },
    { header: "COMMIT", field: "commit" },
    {
      header: "ITEMS",
      field: (snapshot) =>
        snapshot.team.items.map((item) => `${item.title} [${item.phase}]`).join(", "),
    },
    {
      header: "AGENTS",
      field: (snapshot) =>
        snapshot.bindings
          .map((binding) => `${binding.role}: ${binding.agentId} [${binding.turn}]`)
          .join(", "),
    },
  ],
};

const eventSchema: OutputSchema<TeamEventPayload> = {
  idField: (event) => String(event.commit),
  columns: [
    { header: "COMMIT", field: "commit" },
    { header: "AT", field: "at" },
    { header: "TYPE", field: "type" },
    { header: "ACTOR", field: (event) => `${event.actor.type}:${event.actor.id}` },
    { header: "ITEM", field: "workItemId" },
    { header: "TEXT", field: "text" },
  ],
};

const messageSchema: OutputSchema<TeamMessagePayload> = {
  idField: "requestId",
  columns: [{ header: "DELIVERED", field: "ok" }],
};

async function withTeamClient<T>(
  options: CommandOptions,
  operation: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (!client.getLastServerInfoMessage()?.features?.teams) {
      throw { code: "DAEMON_UPDATE_REQUIRED", message: "Update the host to use teams." };
    }
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function runLs(options: CommandOptions, _command: Command): Promise<ListResult<TeamSummary>> {
  return withTeamClient(options, async (client) => {
    const { teams } = await client.listTeams();
    return { type: "list", data: teams, schema: teamSchema };
  });
}

async function runInspect(
  teamId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<TeamEventsPayload>> {
  return withTeamClient(options, async (client) => ({
    type: "single",
    data: await client.getTeamEvents({ teamId }),
    schema: inspectSchema,
  }));
}

interface EventsOptions extends CommandOptions {
  after?: number;
}

async function runEvents(
  teamId: string,
  options: EventsOptions,
  _command: Command,
): Promise<ListResult<TeamEventPayload>> {
  return withTeamClient(options, async (client) => {
    const { events } = await client.getTeamEvents({ teamId, afterCommit: options.after });
    return { type: "list", data: events, schema: eventSchema };
  });
}

async function runMessage(
  teamId: string,
  text: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<TeamMessagePayload>> {
  const trimmed = text.trim();
  if (!trimmed) throw { code: "TEAM_MESSAGE_EMPTY", message: "Team messages cannot be empty." };
  return withTeamClient(options, async (client) => {
    const result = await client.sendTeamMessage({ teamId, text: trimmed });
    if (!result.ok)
      throw { code: "TEAM_MESSAGE_FAILED", message: result.error ?? "Message was not delivered." };
    return { type: "single", data: result, schema: messageSchema };
  });
}

function parseCommit(value: string): number {
  const commit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(commit)) {
    throw new InvalidArgumentError("Commit must be a non-negative safe integer.");
  }
  return commit;
}

export function createTeamCommand(): Command {
  const team = new Command("team").description(
    "Inspect team work, read events, and send input to the team",
  );
  addJsonAndDaemonHostOptions(
    team.command("ls").description("List teams and work item phases"),
  ).action(withOutput(runLs));
  addJsonAndDaemonHostOptions(
    team
      .command("inspect")
      .description("Show team state and agents; --json also includes event history")
      .argument("<team-id>"),
  ).action(withOutput(runInspect));
  addJsonAndDaemonHostOptions(
    team
      .command("events")
      .description("Read team events once")
      .argument("<team-id>")
      .option("--after <commit>", "Only events after this team commit", parseCommit),
  ).action(withOutput(runEvents));
  addJsonAndDaemonHostOptions(
    team
      .command("message")
      .description("Send input to the team and resume waiting work")
      .argument("<team-id>")
      .argument("<text>"),
  ).action(withOutput(runMessage));
  return team;
}
