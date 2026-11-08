import {
  AGENT_TEAM_ROLE_LABEL,
  type ResolvedAgentTeam,
  type ResolvedAgentTeamRole,
} from "./agent-teams.js";

function formatCreateAgentParameters(role: ResolvedAgentTeamRole): string {
  const provider = role.model ? `${role.provider}/${role.model}` : `${role.provider}/<model>`;
  const settings: Record<string, unknown> = {
    ...(role.modeId ? { modeId: role.modeId } : {}),
    ...(role.thinkingOptionId ? { thinkingOptionId: role.thinkingOptionId } : {}),
    ...(role.featureValues ? { features: role.featureValues } : {}),
  };
  const parts = [`provider: ${JSON.stringify(provider)}`];
  if (Object.keys(settings).length > 0) parts.push(`settings: ${JSON.stringify(settings)}`);
  parts.push(`labels: ${JSON.stringify({ [AGENT_TEAM_ROLE_LABEL]: role.name })}`);
  const suffix = role.model ? "" : ` (pick a ${role.provider} model with inspect_provider)`;
  return `create_agent ${parts.join(", ")}${suffix}`;
}

function formatIsolation(role: ResolvedAgentTeamRole): string | null {
  if (role.isolation === "worktree") {
    return 'Isolation: call create_workspace with isolation "worktree" first, then pass its workspaceId to create_agent.';
  }
  if (role.isolation === "local") {
    return "Isolation: work in your current workspace (omit workspaceId).";
  }
  return null;
}

function formatRole(role: ResolvedAgentTeamRole): string {
  const lines = [`- ${role.name}: ${role.description}`, `  ${formatCreateAgentParameters(role)}`];
  const isolation = formatIsolation(role);
  if (isolation) lines.push(`  ${isolation}`);
  return lines.join("\n");
}

/**
 * The instructions a team chat receives in its system prompt: who is on the
 * team, the exact create_agent parameters per role, and how to delegate.
 */
export function buildAgentTeamRosterPrompt(team: ResolvedAgentTeam): string {
  const header = [
    `You lead the "${team.name}" team.${team.description ? ` ${team.description}` : ""}`,
    "Delegate work by role instead of doing all of it yourself. Create each helper with the create_agent tool using its role's parameters:",
  ].join("\n");
  const peerRules = team.peerMessaging
    ? [
        "- Peer messaging is on. Tell each helper in its initialPrompt: list_team_members shows the team (the member with isParent true is you), and send_team_message { agentId, message } reaches any member, you included. Helpers that review each other's work can talk directly.",
      ]
    : [];
  const rules = [
    "Rules:",
    "- Give each helper a self-contained prompt: the goal, the relevant files, the constraints, and what to report back. Helpers do not see this conversation.",
    "- When a role sets no modeId and its provider differs from yours, pass settings.modeId; inspect_provider lists the modes.",
    "- Use wait_for_agent when you need a helper's result before you continue. Keep notifyOnFinish on and keep working when you don't.",
    `- Keep the labels shown above: the ${AGENT_TEAM_ROLE_LABEL} label is how teammates see each helper's role.`,
    ...peerRules,
    "- You stay responsible for the outcome: check each helper's result before you rely on it, and integrate it yourself.",
  ].join("\n");
  return [header, team.roles.map(formatRole).join("\n"), rules].join("\n\n");
}
