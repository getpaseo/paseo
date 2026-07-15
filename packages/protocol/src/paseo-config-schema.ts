import { z } from "zod";

export function normalizeLifecycleCommands(commands: unknown): string[] {
  if (typeof commands === "string") {
    return commands.trim().length > 0 ? [commands] : [];
  }
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.filter((command): command is string => {
    return typeof command === "string" && command.trim().length > 0;
  });
}

/**
 * One layer of the agent's environment. A string in paseo.json is a command that prints
 * the environment to stdout; an object is a static set of variables.
 */
export type AgentEnvLayer =
  | { kind: "static"; vars: Record<string, string> }
  | { kind: "command"; command: string };

function normalizeAgentEnvLayer(value: unknown): AgentEnvLayer | undefined {
  if (typeof value === "string") {
    const command = value.trim();
    return command.length > 0 ? { kind: "command", command } : undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const vars: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 0 && typeof entry === "string") {
      vars[key] = entry;
    }
  }
  return Object.keys(vars).length > 0 ? { kind: "static", vars } : undefined;
}

/**
 * `agentEnv` accepts a single layer or an ordered list of them. Layers are merged
 * left to right, so precedence is visible in the file rather than a documented rule.
 * Unset, blank, and malformed entries drop out; a config with nothing left is undefined
 * rather than an empty list, so parsing a config that never mentions `agentEnv` doesn't
 * invent the key.
 */
export function normalizeAgentEnv(value: unknown): AgentEnvLayer[] | undefined {
  const entries = Array.isArray(value) ? value : [value];
  const layers: AgentEnvLayer[] = [];
  for (const entry of entries) {
    const layer = normalizeAgentEnvLayer(entry);
    if (layer) {
      layers.push(layer);
    }
  }
  return layers.length > 0 ? layers : undefined;
}

export const PaseoLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

// A command string, or a static map of variables. No shared literal tag, so a plain
// union is correct here (a discriminated union needs a tag to discriminate on).
export const AgentEnvLayerRawSchema = z.union([z.string(), z.record(z.string(), z.string())]);
export const AgentEnvRawSchema = z.union([AgentEnvLayerRawSchema, z.array(AgentEnvLayerRawSchema)]);

export const PaseoScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const PaseoWorktreeConfigRawSchema = z
  .object({
    setup: PaseoLifecycleCommandRawSchema.optional(),
    teardown: PaseoLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
  })
  .passthrough();

export const PaseoMetadataGenerationEntrySchema = z
  .object({
    instructions: z.string().optional(),
  })
  .passthrough()
  .catch({});

export const PaseoMetadataGenerationSchema = z
  .object({
    title: PaseoMetadataGenerationEntrySchema.optional(),
    branchName: PaseoMetadataGenerationEntrySchema.optional(),
    commitMessage: PaseoMetadataGenerationEntrySchema.optional(),
    pullRequest: PaseoMetadataGenerationEntrySchema.optional(),
  })
  // COMPAT(projectMetadataAgentTitle): `agentTitle` project metadata prompts were removed
  // in v0.1.96; keep legacy paseo.json parseable until 2026-12-16.
  .passthrough()
  .catch({});

export const PaseoConfigRawSchema = z
  .object({
    worktree: PaseoWorktreeConfigRawSchema.optional(),
    // The environment for the agent CLI (and the MCP servers it spawns), resolved before the
    // CLI starts: static vars, a command that prints the env to stdout, or an ordered list of
    // both. Top-level, not under `worktree`: this is an agent-launch concern, not worktree
    // lifecycle. See server/agent/pre-launch-env.ts.
    agentEnv: AgentEnvRawSchema.optional(),
    scripts: z.record(z.string(), PaseoScriptEntryRawSchema).optional(),
    metadataGeneration: PaseoMetadataGenerationSchema.optional(),
  })
  .passthrough();

export const WorktreeConfigSchema = PaseoWorktreeConfigRawSchema.extend({
  setup: z.unknown().optional().transform(normalizeLifecycleCommands),
  teardown: z.unknown().optional().transform(normalizeLifecycleCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const ScriptEntrySchema = PaseoScriptEntryRawSchema.catch({});

export const PaseoConfigSchema = PaseoConfigRawSchema.extend({
  worktree: WorktreeConfigSchema.optional(),
  agentEnv: z.unknown().optional().transform(normalizeAgentEnv),
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
  metadataGeneration: PaseoMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({ agentEnv: undefined });

export const PaseoConfigRevisionSchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
});

export const ProjectConfigRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("project_not_found") }),
  z.object({ code: z.literal("invalid_project_config") }),
  z.object({
    code: z.literal("stale_project_config"),
    currentRevision: PaseoConfigRevisionSchema.nullable(),
  }),
  z.object({ code: z.literal("write_failed") }),
]);

export type PaseoScriptEntryRaw = z.infer<typeof PaseoScriptEntryRawSchema>;
export type PaseoMetadataGenerationEntry = z.infer<typeof PaseoMetadataGenerationEntrySchema>;
export type PaseoMetadataGeneration = z.infer<typeof PaseoMetadataGenerationSchema>;
export type PaseoConfigRaw = z.infer<typeof PaseoConfigRawSchema>;
export type PaseoConfig = z.infer<typeof PaseoConfigSchema>;
export type PaseoConfigRevision = z.infer<typeof PaseoConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
