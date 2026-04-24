import { z } from "zod";

/**
 * A Hubcode slash-command — a named, reusable prompt users can invoke inside
 * any supported CLI or GUI agent. The canonical definition lives here; adapters
 * install it into each agent's native command/prompt directory.
 *
 * Design notes:
 *   - `name` is the invocation slug (`plan` → `/plan`). Must be filesystem-safe.
 *   - `prompt` is markdown (same format every supported agent consumes).
 *   - `scope` chooses where the command becomes available:
 *       global  — installed to the user's home config for every activated CLI
 *       project — installed into the `.claude|.codex|...` folder of each
 *                 path in `projectPaths`
 *   - `author === "builtin"` ships with the daemon; users can toggle but not
 *     delete. Everything else is authored in the Settings UI.
 */

export const CommandScopeSchema = z.enum(["global", "project"]);
export type CommandScope = z.infer<typeof CommandScopeSchema>;

/** Matches a filesystem-safe slug: `plan`, `code-review`, `tdd_cycle`. */
export const CommandNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "Use letters, digits, dot, dash or underscore");

export const HubcodeCommandSchema = z.object({
  id: z.string().min(1),
  /** Slug used as the slash invocation and filename. */
  name: CommandNameSchema,
  /** Short human-readable label (defaults to name). */
  displayName: z.string().optional(),
  description: z.string(),
  /** Markdown body that gets expanded when the slash command is triggered. */
  prompt: z.string().min(1),

  author: z.union([z.literal("builtin"), z.string()]),
  scope: CommandScopeSchema,
  /** Relevant when scope === "project". Absolute filesystem paths. */
  projectPaths: z.array(z.string()).optional(),

  /**
   * CLI provider IDs (from `shared/cli-provider-registry`) plus "hubcode-gui"
   * that this command should be installed into. Empty/undefined = all
   * supported agents. Used for commands that are agent-specific.
   */
  targetAgents: z.array(z.string()).optional(),

  tags: z.array(z.string()).optional(),
});

export type HubcodeCommand = z.infer<typeof HubcodeCommandSchema>;

/** Per-agent install status for a single command, surfaced in the UI. */
export interface CommandInstallStatus {
  agentId: string;
  /** True when the CLI is currently detected/enabled on the host. */
  agentActive: boolean;
  status: "installed" | "not-installed" | "unsupported" | "disabled" | "error";
  reason?: string;
}

export interface CommandRuntimeState {
  enabled: boolean;
  installStatus?: CommandInstallStatus[];
}

export interface CommandWithState {
  definition: HubcodeCommand;
  state: CommandRuntimeState;
}
