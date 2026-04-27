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

export const HubcodeLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

export const HubcodeScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const HubcodeWorktreeConfigRawSchema = z
  .object({
    setup: HubcodeLifecycleCommandRawSchema.optional(),
    teardown: HubcodeLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
  })
  .passthrough();

export const HubcodeConfigRawSchema = z
  .object({
    worktree: HubcodeWorktreeConfigRawSchema.optional(),
    scripts: z.record(z.string(), HubcodeScriptEntryRawSchema).optional(),
  })
  .passthrough();

export const WorktreeConfigSchema = HubcodeWorktreeConfigRawSchema.extend({
  setup: z.unknown().transform(normalizeLifecycleCommands),
  teardown: z.unknown().transform(normalizeLifecycleCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const ScriptEntrySchema = HubcodeScriptEntryRawSchema.catch({});

export const HubcodeConfigSchema = HubcodeConfigRawSchema.extend({
  worktree: WorktreeConfigSchema.optional(),
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
})
  .passthrough()
  .catch({});

export const HubcodeConfigRevisionSchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
});

export const ProjectConfigRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("project_not_found") }),
  z.object({ code: z.literal("invalid_project_config") }),
  z.object({
    code: z.literal("stale_project_config"),
    currentRevision: HubcodeConfigRevisionSchema.nullable(),
  }),
  z.object({ code: z.literal("write_failed") }),
]);

export type HubcodeScriptEntryRaw = z.infer<typeof HubcodeScriptEntryRawSchema>;
export type HubcodeConfigRaw = z.infer<typeof HubcodeConfigRawSchema>;
export type HubcodeConfig = z.infer<typeof HubcodeConfigSchema>;
export type HubcodeConfigRevision = z.infer<typeof HubcodeConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
