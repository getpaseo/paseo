import type { AgentSkillSelection } from "@getpaseo/protocol/messages";
import { getHostClient } from "@/runtime/host-runtime";

export async function importLegacyAgentSkillsSelection(
  serverId: string,
  selection: AgentSkillSelection,
): Promise<boolean> {
  const client = getHostClient(serverId);
  if (!client) return false;
  await client.importLegacyAgentSkillsSelection(selection);
  return true;
}
