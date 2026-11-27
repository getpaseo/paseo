import { z } from "zod";

/**
 * Wire shape of `daemon.teams` in the mutable daemon config. Structural only:
 * the daemon owns the semantic rules (a role names exactly one of `profile` or
 * `provider`, a team has at least one role) and rejects a patch that breaks
 * them. Objects pass unknown keys through so a client that edits one team and
 * writes the record back does not strip fields a newer daemon added.
 * `isolation` is a string, not an enum, so a new value from a newer daemon
 * still parses.
 */
export const AgentTeamRoleConfigWireSchema = z
  .object({
    description: z.string(),
    profile: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    isolation: z.string().optional(),
  })
  .passthrough();

export const AgentTeamConfigWireSchema = z
  .object({
    description: z.string().optional(),
    peerMessaging: z.boolean().optional(),
    roles: z.record(z.string(), AgentTeamRoleConfigWireSchema),
  })
  .passthrough();

export const AgentTeamsConfigWireSchema = z.record(z.string(), AgentTeamConfigWireSchema);

export type AgentTeamRoleConfigWire = z.infer<typeof AgentTeamRoleConfigWireSchema>;
export type AgentTeamConfigWire = z.infer<typeof AgentTeamConfigWireSchema>;
export type AgentTeamsConfigWire = z.infer<typeof AgentTeamsConfigWireSchema>;
