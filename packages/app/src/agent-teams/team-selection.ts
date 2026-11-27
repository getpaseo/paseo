import type { FormPreferences } from "@/create-agent-preferences/preferences";

/**
 * The remembered team for a host, or null when none is remembered or the host
 * no longer defines it. Teams are per host, so the preference is keyed by server.
 */
export function resolveSelectedTeam(input: {
  preferences: FormPreferences;
  serverId: string | null;
  teamNames: readonly string[];
}): string | null {
  if (!input.serverId) return null;
  const remembered = input.preferences.teamByServer?.[input.serverId];
  return remembered && input.teamNames.includes(remembered) ? remembered : null;
}

/** Remembers `team` for the host; null forgets it ("None"). */
export function rememberSelectedTeam(input: {
  preferences: FormPreferences;
  serverId: string;
  team: string | null;
}): FormPreferences {
  const { [input.serverId]: _previous, ...others } = input.preferences.teamByServer ?? {};
  const teamByServer = input.team ? { ...others, [input.serverId]: input.team } : others;
  const next: FormPreferences = { ...input.preferences, teamByServer };
  if (Object.keys(teamByServer).length === 0) delete next.teamByServer;
  return next;
}

/** What a role starts helpers on: "provider/model", or the bare provider when it sets no model. */
export function formatTeamRoleModel(role: { provider: string; model?: string }): string {
  return role.model ? `${role.provider}/${role.model}` : role.provider;
}

/** One line per team for the picker: each role with the provider and model it runs on. */
export function describeTeamRoles(
  roles: readonly { name: string; provider: string; model?: string }[],
): string {
  return roles.map((role) => `${role.name} (${formatTeamRoleModel(role)})`).join(", ");
}

/**
 * Sets or clears one role's model override for the chat being created. Choosing the role's
 * configured model, or null, clears it, so only real overrides reach the daemon.
 */
export function setRoleModelOverride(input: {
  overrides: Readonly<Record<string, string>>;
  role: string;
  model: string | null;
  configuredModel: string | undefined;
}): Record<string, string> {
  const { [input.role]: _previous, ...others } = input.overrides;
  if (!input.model || input.model === input.configuredModel) return others;
  return { ...others, [input.role]: input.model };
}
