import { z } from "zod";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";

import { AGENT_TEAM_LABEL, AGENT_TEAM_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";

export { AGENT_TEAM_LABEL, AGENT_TEAM_ROLE_LABEL };

/**
 * Stamped by the daemon on every helper a team chat (or one of its helpers)
 * creates; the value is the team chat's agent id. Agents cannot set it.
 */
export const AGENT_TEAM_RUN_LABEL = "paseo.team-run";
/** Labels only the daemon may set; agent-facing tools strip or refuse them. */
export const DAEMON_OWNED_TEAM_LABELS: readonly string[] = [AGENT_TEAM_LABEL, AGENT_TEAM_RUN_LABEL];

/**
 * The team run an agent belongs to: its `paseo.team-run` label, or its own id
 * when it is the team chat (carries `paseo.team`). Null outside a team run.
 */
export function resolveTeamRunId(agent: {
  id: string;
  labels?: Record<string, string> | null;
}): string | null {
  const run = agent.labels?.[AGENT_TEAM_RUN_LABEL]?.trim();
  if (run) return run;
  return agent.labels?.[AGENT_TEAM_LABEL]?.trim() ? agent.id : null;
}

const TeamNameSchema = z.string().trim().min(1);

export const AgentTeamRoleConfigSchema = z
  .object({
    description: z.string().trim().min(1),
    /** An agent profile id or name. Mutually exclusive with `provider`. */
    profile: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    modeId: z.string().trim().min(1).optional(),
    thinkingOptionId: z.string().trim().min(1).optional(),
    isolation: z.enum(["worktree", "local"]).optional(),
  })
  .strict()
  .superRefine((role, ctx) => {
    if ((role.profile === undefined) === (role.provider === undefined)) {
      ctx.addIssue({ code: "custom", message: "A role names exactly one of profile or provider" });
    }
    if (
      role.profile !== undefined &&
      (role.model !== undefined || role.modeId !== undefined || role.thinkingOptionId !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A profile role takes model, modeId and thinkingOptionId from the profile",
      });
    }
  });

export const AgentTeamConfigSchema = z
  .object({
    description: z.string().optional(),
    /** Lets members of one team run message each other with send_team_message. */
    peerMessaging: z.boolean().optional(),
    roles: z
      .record(TeamNameSchema, AgentTeamRoleConfigSchema)
      .refine((roles) => Object.keys(roles).length > 0, "A team needs at least one role"),
  })
  .strict();

export const AgentTeamsConfigSchema = z.record(TeamNameSchema, AgentTeamConfigSchema);

/**
 * The teams in the mutable daemon config, in the daemon's own shape. The config
 * store only holds teams that passed `AgentTeamsConfigSchema`; the wire type is
 * looser so old clients keep parsing newer daemons.
 */
export function readAgentTeamsConfig(config: { teams?: unknown }): AgentTeamsConfig | undefined {
  return config.teams === undefined ? undefined : AgentTeamsConfigSchema.parse(config.teams);
}

/** Validates teams written through the config RPC, with a message a person can act on. */
export function parseAgentTeamsConfigPatch(value: unknown): AgentTeamsConfig {
  const result = AgentTeamsConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid daemon.teams: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export type AgentTeamRoleConfig = z.infer<typeof AgentTeamRoleConfigSchema>;
export type AgentTeamConfig = z.infer<typeof AgentTeamConfigSchema>;
export type AgentTeamsConfig = z.infer<typeof AgentTeamsConfigSchema>;

export interface ResolvedAgentTeamRole {
  name: string;
  description: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  /** The referenced profile's name, when the role names a profile. */
  profile?: string;
  isolation?: "worktree" | "local";
}

export interface ResolvedAgentTeam {
  name: string;
  description?: string;
  peerMessaging?: boolean;
  roles: ResolvedAgentTeamRole[];
}

export class AgentTeamNotFoundError extends Error {
  constructor(public readonly teamName: string) {
    super(`Team "${teamName}" is not defined in daemon.teams`);
    this.name = "AgentTeamNotFoundError";
  }
}

export class AgentTeamProfileNotFoundError extends Error {
  constructor(
    public readonly teamName: string,
    public readonly roleName: string,
    public readonly profile: string,
  ) {
    super(`Team "${teamName}" role "${roleName}" references unknown agent profile "${profile}"`);
    this.name = "AgentTeamProfileNotFoundError";
  }
}

export class AgentTeamRoleNotFoundError extends Error {
  constructor(
    public readonly teamName: string,
    public readonly roleName: string,
  ) {
    super(`Team "${teamName}" has no role "${roleName}"`);
    this.name = "AgentTeamRoleNotFoundError";
  }
}

function findProfile(profiles: readonly AgentProfile[], reference: string): AgentProfile | null {
  return (
    profiles.find((profile) => profile.id === reference) ??
    profiles.find((profile) => profile.name === reference) ??
    null
  );
}

function resolveRole(input: {
  teamName: string;
  roleName: string;
  role: AgentTeamRoleConfig;
  agentProfiles: readonly AgentProfile[];
}): ResolvedAgentTeamRole {
  const { teamName, roleName, role } = input;
  const base = {
    name: roleName,
    description: role.description,
    ...(role.isolation ? { isolation: role.isolation } : {}),
  };
  if (role.profile !== undefined) {
    const profile = findProfile(input.agentProfiles, role.profile);
    if (!profile) throw new AgentTeamProfileNotFoundError(teamName, roleName, role.profile);
    return {
      ...base,
      provider: profile.provider,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
      ...(profile.featureValues && Object.keys(profile.featureValues).length > 0
        ? { featureValues: profile.featureValues }
        : {}),
      profile: profile.name,
    };
  }
  return {
    ...base,
    provider: role.provider ?? "",
    ...(role.model ? { model: role.model } : {}),
    ...(role.modeId ? { modeId: role.modeId } : {}),
    ...(role.thinkingOptionId ? { thinkingOptionId: role.thinkingOptionId } : {}),
  };
}

function resolveTeam(input: {
  name: string;
  team: AgentTeamConfig;
  agentProfiles: readonly AgentProfile[];
}): ResolvedAgentTeam {
  return {
    name: input.name,
    ...(input.team.description ? { description: input.team.description } : {}),
    ...(input.team.peerMessaging ? { peerMessaging: true } : {}),
    roles: Object.entries(input.team.roles).map(([roleName, role]) =>
      resolveRole({ teamName: input.name, roleName, role, agentProfiles: input.agentProfiles }),
    ),
  };
}

/** Resolves one team against the current agent profiles. Throws on an unknown team or profile. */
export function resolveAgentTeam(input: {
  teams: AgentTeamsConfig | undefined;
  agentProfiles: readonly AgentProfile[] | undefined;
  name: string;
}): ResolvedAgentTeam {
  const team = input.teams?.[input.name];
  if (!team) throw new AgentTeamNotFoundError(input.name);
  return resolveTeam({ name: input.name, team, agentProfiles: input.agentProfiles ?? [] });
}

/**
 * Replaces the models of the named roles for one chat. A thinking option belongs to a model, so
 * a role whose model changes drops its configured one. Throws on an unknown role or empty model.
 */
export function applyAgentTeamModelOverrides(
  team: ResolvedAgentTeam,
  overrides: Readonly<Record<string, string>> | undefined,
): ResolvedAgentTeam {
  if (!overrides) return team;
  const roleNames = new Set(team.roles.map((role) => role.name));
  const models = new Map<string, string>();
  for (const [roleName, model] of Object.entries(overrides)) {
    if (!roleNames.has(roleName)) throw new AgentTeamRoleNotFoundError(team.name, roleName);
    const trimmed = model.trim();
    if (!trimmed) throw new Error(`Team "${team.name}" role "${roleName}" model override is empty`);
    models.set(roleName, trimmed);
  }
  return {
    ...team,
    roles: team.roles.map((role) => {
      const model = models.get(role.name);
      if (model === undefined || model === role.model) return role;
      const { thinkingOptionId: _dropped, ...rest } = role;
      return { ...rest, model };
    }),
  };
}

/**
 * Resolves every team. A team whose role references a missing profile is left
 * out and reported in `error`, so a picker never offers a team that would fail
 * at creation.
 */
export function listResolvedAgentTeams(input: {
  teams: AgentTeamsConfig | undefined;
  agentProfiles: readonly AgentProfile[] | undefined;
}): { teams: ResolvedAgentTeam[]; error: string | null } {
  const teams: ResolvedAgentTeam[] = [];
  const problems: string[] = [];
  for (const [name, team] of Object.entries(input.teams ?? {})) {
    try {
      teams.push(resolveTeam({ name, team, agentProfiles: input.agentProfiles ?? [] }));
    } catch (error) {
      if (!(error instanceof AgentTeamProfileNotFoundError)) throw error;
      problems.push(error.message);
    }
  }
  return { teams, error: problems.length > 0 ? problems.join("; ") : null };
}
