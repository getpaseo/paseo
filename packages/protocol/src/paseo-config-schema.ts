import { z } from "zod";

const TCP_PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

export const PASEO_PLATFORMS = ["linux", "darwin", "win32"] as const;
export type PaseoPlatform = (typeof PASEO_PLATFORMS)[number];

export const PaseoServicePortAllocationSchema = z
  .object({
    range: z.string().trim().regex(TCP_PORT_RANGE_PATTERN).optional(),
    portScript: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.range !== undefined || value.portScript !== undefined,
    "Expected range or portScript",
  )
  .refine((value) => {
    if (!value.range) return true;
    const match = TCP_PORT_RANGE_PATTERN.exec(value.range);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start >= 1 && end <= 65_535 && start <= end;
  }, "Expected an inclusive TCP port range from 1-65535");

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

export function isPaseoPlatformCommand(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectPaseoPlatformCommand(value: unknown, platform: string): unknown {
  return isPaseoPlatformCommand(value) ? value[platform] : value;
}

const PaseoLifecycleCommandValueRawSchema = z.union([z.string(), z.array(z.string())]);

export const PaseoPlatformScriptCommandRawSchema = z
  .object({
    linux: z.string().optional(),
    darwin: z.string().optional(),
    win32: z.string().optional(),
  })
  .passthrough();

export const PaseoPlatformLifecycleCommandRawSchema = z
  .object({
    linux: PaseoLifecycleCommandValueRawSchema.optional(),
    darwin: PaseoLifecycleCommandValueRawSchema.optional(),
    win32: PaseoLifecycleCommandValueRawSchema.optional(),
  })
  .passthrough();

export const PaseoScriptCommandRawSchema = z.union([
  z.string(),
  z.array(z.string()),
  PaseoPlatformScriptCommandRawSchema,
]);

export const PaseoLifecycleCommandRawSchema = z.union([
  PaseoLifecycleCommandValueRawSchema,
  PaseoPlatformLifecycleCommandRawSchema,
]);

export const PaseoScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: PaseoScriptCommandRawSchema.optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const PaseoWorktreeConfigRawSchema = z
  .object({
    setup: PaseoLifecycleCommandRawSchema.optional(),
    teardown: PaseoLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
    servicePorts: PaseoServicePortAllocationSchema.optional(),
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
    scripts: z.record(z.string(), PaseoScriptEntryRawSchema).optional(),
    metadataGeneration: PaseoMetadataGenerationSchema.optional(),
  })
  .passthrough();

function normalizeLifecycleConfigCommands(
  commands: unknown,
): string[] | PaseoPlatformLifecycleCommandRaw {
  const platformCommands = PaseoPlatformLifecycleCommandRawSchema.safeParse(commands);
  if (platformCommands.success) {
    return platformCommands.data;
  }
  return normalizeLifecycleCommands(commands);
}

export const WorktreeConfigSchema = PaseoWorktreeConfigRawSchema.extend({
  setup: z.unknown().optional().transform(normalizeLifecycleConfigCommands),
  teardown: z.unknown().optional().transform(normalizeLifecycleConfigCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const ScriptEntrySchema = PaseoScriptEntryRawSchema.catch({});

export const PaseoConfigSchema = PaseoConfigRawSchema.extend({
  worktree: WorktreeConfigSchema.optional(),
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
  metadataGeneration: PaseoMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({});

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
export type PaseoPlatformScriptCommandRaw = z.infer<typeof PaseoPlatformScriptCommandRawSchema>;
export type PaseoPlatformLifecycleCommandRaw = z.infer<
  typeof PaseoPlatformLifecycleCommandRawSchema
>;
export type PaseoScriptCommandRaw = z.infer<typeof PaseoScriptCommandRawSchema>;
export type PaseoLifecycleCommandRaw = z.infer<typeof PaseoLifecycleCommandRawSchema>;
export type PaseoMetadataGenerationEntry = z.infer<typeof PaseoMetadataGenerationEntrySchema>;
export type PaseoMetadataGeneration = z.infer<typeof PaseoMetadataGenerationSchema>;
export type PaseoServicePortAllocation = z.infer<typeof PaseoServicePortAllocationSchema>;
export type PaseoConfigRaw = z.infer<typeof PaseoConfigRawSchema>;
export type PaseoConfig = z.infer<typeof PaseoConfigSchema>;
export type PaseoConfigRevision = z.infer<typeof PaseoConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
