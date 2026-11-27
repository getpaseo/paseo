import { z } from "zod";

/**
 * A named launch bundle: a provider plus the agent-config values a client would
 * otherwise set one control at a time. Field names mirror `AgentSessionConfig`
 * so applying a profile is a copy rather than a translation table.
 *
 * `systemPrompt` is creation-only: clients apply it when starting a new agent
 * from the profile and omit it when applying the profile to a running agent.
 */
export const AgentProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** A key into the client's icon registry, not a glyph. Unknown keys draw the default. */
    icon: z.string().optional(),
    /** An identity colour name shared with host badges. Unknown values draw unthemed. */
    color: z.string().optional(),
    provider: z.string(),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read as `options`.
    featureValues: z.record(z.string(), z.unknown()).optional(),
    /** Provider options applied when the profile creates an agent. */
    options: z.record(z.string(), z.unknown()).optional(),
    /** Creation-only system prompt applied when starting a new agent from this profile. */
    systemPrompt: z.string().optional(),
    /** Free text, surfaced to orchestrating agents by the `list_profiles` MCP tool. */
    notes: z.string().optional(),
  })
  .passthrough();

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentSkillSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("custom"), skills: z.array(z.string()) }).strict(),
]);
export type AgentSkillSelection = z.infer<typeof AgentSkillSelectionSchema>;
