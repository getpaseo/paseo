import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

export interface AgentTeamRoleRow {
  team: string;
  role: string;
  provider: string;
  profile: string;
  description: string;
}

/** One row per role, so a team's roster reads top to bottom. */
export const agentTeamsSchema: OutputSchema<AgentTeamRoleRow> = {
  idField: (row) => `${row.team}/${row.role}`,
  columns: [
    { header: "TEAM", field: "team", width: 16 },
    { header: "ROLE", field: "role", width: 14 },
    { header: "PROVIDER", field: "provider", width: 28 },
    { header: "PROFILE", field: "profile", width: 18 },
    { header: "DESCRIPTION", field: "description", width: 40 },
  ],
};

export async function runTeamsCommand(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<AgentTeamRoleRow>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const { teams, error } = await client.listAgentTeams();
    if (error) console.error(`Warning: ${error}`);
    return {
      type: "list",
      data: teams.flatMap((team) =>
        team.roles.map((role) => ({
          team: team.name,
          role: role.name,
          provider: role.model ? `${role.provider}/${role.model}` : role.provider,
          profile: role.profile ?? "",
          description: role.description,
        })),
      ),
      schema: agentTeamsSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
