import { z } from "zod";

const TCP_PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

export const PaseoServicePortAllocationSchema = z
  .object({
    range: z.string().trim().regex(TCP_PORT_RANGE_PATTERN).optional(),
    portScript: z.string().trim().min(1).optional(),
    // A workspace launch leases one contiguous block. Keep this optional so
    // existing servicePorts configurations remain valid without an edit.
    blockSize: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.range !== undefined || value.portScript !== undefined || value.blockSize !== undefined,
    "Expected range, portScript, or blockSize",
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

export const PaseoLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

export const PaseoScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const PaseoLaunchEntryRawSchema = z
  .object({
    command: z.unknown().optional(),
  })
  .passthrough();

export const PaseoWorktreeConfigRawSchema = z
  .object({
    setup: PaseoLifecycleCommandRawSchema.optional(),
    teardown: PaseoLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
    // Keep the block size outside the strict servicePorts object on the wire:
    // older clients parse worktree passthrough fields but reject unknown servicePorts keys.
    portBlockSize: z.number().int().min(1).max(1000).optional(),
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
    launches: z.record(z.string(), PaseoLaunchEntryRawSchema).optional(),
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
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
  launches: z.record(z.string(), PaseoLaunchEntryRawSchema.catch({})).optional().catch({}),
  metadataGeneration: PaseoMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({});

export function getWorkspaceServicePortAllocation(
  worktree: PaseoConfig["worktree"] | undefined,
): PaseoServicePortAllocation | undefined {
  if (!worktree) return undefined;
  const { portBlockSize, servicePorts } = worktree;
  const blockSize = portBlockSize ?? servicePorts?.blockSize;
  if (!servicePorts && blockSize === undefined) return undefined;
  return {
    ...servicePorts,
    ...(blockSize === undefined ? {} : { blockSize }),
  };
}

/** Move the legacy strict-object field to a location old clients pass through. */
export function toPaseoConfigRpcShape(config: PaseoConfigRaw): PaseoConfigRaw;
export function toPaseoConfigRpcShape(config: null): null;
export function toPaseoConfigRpcShape(config: PaseoConfigRaw | null): PaseoConfigRaw | null;
export function toPaseoConfigRpcShape(config: PaseoConfigRaw | null): PaseoConfigRaw | null {
  // COMPAT(projectConfigPortBlockSize): added in v0.15.0; remove after 2027-11-04.
  const worktree = config?.worktree;
  const servicePorts = worktree?.servicePorts;
  if (!config || !worktree || servicePorts?.blockSize === undefined) return config;

  const { blockSize, ...legacyAllocation } = servicePorts;
  const hasLegacyAllocation =
    legacyAllocation.range !== undefined || legacyAllocation.portScript !== undefined;
  const worktreeWithoutServicePorts = { ...worktree };
  delete worktreeWithoutServicePorts.servicePorts;
  return {
    ...config,
    worktree: {
      ...worktreeWithoutServicePorts,
      portBlockSize: worktree.portBlockSize ?? blockSize,
      ...(hasLegacyAllocation ? { servicePorts: legacyAllocation } : {}),
    },
  };
}

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
export type PaseoLaunchEntryRaw = z.infer<typeof PaseoLaunchEntryRawSchema>;
export type PaseoMetadataGenerationEntry = z.infer<typeof PaseoMetadataGenerationEntrySchema>;
export type PaseoMetadataGeneration = z.infer<typeof PaseoMetadataGenerationSchema>;
export type PaseoServicePortAllocation = z.infer<typeof PaseoServicePortAllocationSchema>;
export type PaseoConfigRaw = z.infer<typeof PaseoConfigRawSchema>;
export type PaseoConfig = z.infer<typeof PaseoConfigSchema>;
export type PaseoConfigRevision = z.infer<typeof PaseoConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
