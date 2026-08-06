import { z } from "zod";

/**
 * How a setup entry reports the environment it produced.
 *
 * - `json`: an object of `KEY: string | null`. A string sets the variable, `null`
 *   unsets it, and anything not mentioned is left alone. This is what
 *   `direnv export json` prints.
 * - `env0`: NUL-separated `KEY=VALUE` records — a complete environment, as
 *   printed by `env -0`. Anything the daemon started with and the snapshot omits
 *   is unset. Newline-separated `env` output has no format because a value
 *   containing a newline cannot be told apart from a record boundary.
 */
export const AgentEnvironmentFormatSchema = z.enum(["json", "env0"]);
export type AgentEnvironmentFormat = z.infer<typeof AgentEnvironmentFormatSchema>;

export const AgentEnvironmentEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("preset"),
      id: z.string().min(1),
      preset: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("command"),
      id: z.string().min(1),
      command: z.array(z.string()).min(1),
      format: AgentEnvironmentFormatSchema.optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .passthrough(),
]);
export type AgentEnvironmentEntry = z.infer<typeof AgentEnvironmentEntrySchema>;

// No `.default()` on `entries`: defaults belong on primitive leaves in inbound
// message schemas, not array containers. See docs/protocol-validation.md.
export const MutableAgentEnvironmentConfigSchema = z
  .object({
    entries: z.array(AgentEnvironmentEntrySchema),
    timeoutMs: z.number().int().positive().optional(),
  })
  .passthrough();
export type MutableAgentEnvironmentConfig = z.infer<typeof MutableAgentEnvironmentConfigSchema>;

export const MutableAgentEnvironmentConfigPatchSchema = z
  .object({
    entries: z.array(AgentEnvironmentEntrySchema).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .passthrough();

/**
 * A per-directory environment tool Paseo can drive without being configured.
 *
 * A preset applies to a directory when its binary is on the daemon's PATH and
 * one of its markers exists at that directory or above it — the two facts the
 * tool itself uses to decide whether it has anything to do. Adding support for
 * another tool is one entry here.
 *
 * `label` and `description` are deliberately untranslated: like provider and
 * command names, they name a third-party tool. See docs/i18n.md.
 */
export interface AgentEnvironmentPreset {
  id: string;
  label: string;
  description: string;
  binary: string;
  markers: string[];
  command: string[];
  format: AgentEnvironmentFormat;
}

export const AGENT_ENVIRONMENT_PRESETS: readonly AgentEnvironmentPreset[] = [
  {
    id: "direnv",
    label: "direnv",
    description: "Loads the allowed .envrc for the agent's directory.",
    binary: "direnv",
    markers: [".envrc"],
    // `export json` rather than `exec <dir> env -0`: exec leaks DIRENV_IN_ENVRC
    // into the agent, which makes a nested direnv think it is mid-evaluation.
    // `reload` is not an option at all — it prints nothing outside a hooked shell.
    command: ["direnv", "export", "json"],
    format: "json",
  },
];

export function findAgentEnvironmentPreset(id: string): AgentEnvironmentPreset | undefined {
  return AGENT_ENVIRONMENT_PRESETS.find((preset) => preset.id === id);
}

/**
 * What a daemon that has never been configured runs. direnv is seeded rather
 * than special-cased so that removing it in Settings is durable — an empty list
 * means the user emptied it, not that the daemon has no opinion yet.
 */
export const DEFAULT_AGENT_ENVIRONMENT_ENTRIES: readonly AgentEnvironmentEntry[] = [
  { kind: "preset", id: "direnv", preset: "direnv" },
];
