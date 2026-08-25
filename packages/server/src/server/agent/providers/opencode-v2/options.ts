import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const PermissionActionSchema = z.enum(["ask", "allow", "deny"]);
const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.record(z.string(), PermissionActionSchema),
]);

// OpenCode v2 Config.permission, maintained against @opencode-ai/client 0.0.0-beta-18155.
// v2 action names differ from v1: shell/edit/read/grep/glob/webfetch/websearch/subagent/
// external_directory plus the "*" catch-all. v2 has no bash/list/task/todowrite/question
// actions (those are v1 concepts).
export const OpenCodeV2ProviderOptionsSchema = z
  .object({
    permission: z
      .union([
        PermissionActionSchema,
        z
          .object({
            shell: PermissionRuleSchema.optional(),
            edit: PermissionRuleSchema.optional(),
            read: PermissionRuleSchema.optional(),
            grep: PermissionRuleSchema.optional(),
            glob: PermissionRuleSchema.optional(),
            webfetch: PermissionRuleSchema.optional(),
            websearch: PermissionRuleSchema.optional(),
            subagent: PermissionRuleSchema.optional(),
            external_directory: PermissionRuleSchema.optional(),
            "*": PermissionRuleSchema.optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict() satisfies z.ZodType<ProviderOptions>;

export type OpenCodeV2ProviderOptions = z.infer<typeof OpenCodeV2ProviderOptionsSchema>;
