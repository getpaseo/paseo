import { waitForLocationReady } from "./readiness.js";

import type { V2Api } from "./api.js";

import type { AgentSlashCommand } from "../../../agent-sdk-types.js";

export async function commands(client: V2Api, directory: string): Promise<AgentSlashCommand[]> {
  const location = { directory };
  await waitForLocationReady({ client, location });
  const [configured, skills] = await Promise.all([
    client.command.list({ location }),
    client.skill.list({ location }),
  ]);
  const result = new Map<string, AgentSlashCommand>();
  for (const name of ["compact", "summarize"])
    result.set(name, {
      name,
      description: "Compact the current session",
      argumentHint: "",
      kind: "command",
    });
  for (const command of configured.data)
    result.set(command.name, {
      name: command.name,
      description: command.description ?? "",
      argumentHint: "",
      kind: "command",
    });
  for (const skill of skills.data) {
    if (result.has(skill.id)) continue;
    result.set(skill.id, {
      name: skill.id,
      description: skill.description ?? "",
      argumentHint: "",
      kind: "skill",
    });
  }
  return [...result.values()];
}
