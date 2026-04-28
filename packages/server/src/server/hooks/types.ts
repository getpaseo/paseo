import { z } from "zod";

/**
 * A Hubcode hook — a user- or built-in-authored script that observes (and
 * optionally annotates) agent tool calls across every supported CLI/GUI
 * agent. Hubcode holds the canonical definition and per-agent adapters
 * translate it into whatever native mechanism each agent exposes (Claude
 * Code's `settings.json` hooks, Codex's TOML, an SDK tool-result callback
 * for Hubcode GUI, etc.).
 *
 * Design notes:
 *   - Tool names are CANONICAL (`read`, `grep`, `edit`, …). Adapters map to
 *     each agent's native names. Keeps user-authored hooks portable.
 *   - `source` is either an inline script (when `runtime === "inline"`) or
 *     a filesystem path to a script executable by the chosen runtime.
 *   - `enabled` is distinct from the definition so built-ins can exist
 *     without the user being able to delete them — only toggle off.
 *   - `author === "builtin"` marks hooks shipped with the daemon. Users
 *     cannot delete these, only disable.
 */

export const HookTriggerSchema = z.enum([
  "post-tool-use",
  "pre-tool-use",
  "session-start",
  "session-end",
]);

export const HookRuntimeSchema = z.enum(["node", "bash", "python", "inline"]);

export const CanonicalToolSchema = z.enum([
  "read",
  "grep",
  "glob",
  "edit",
  "write",
  "bash",
  "task",
  "fetch",
  "todo",
  "other",
]);

export const HookMatcherSchema = z.object({
  /** Canonical tool identifiers — empty array means "any tool". */
  tools: z.array(CanonicalToolSchema).optional(),
  /** Optional glob pattern applied to file_path / cwd when present. */
  fileGlob: z.string().optional(),
});

export const HookConditionsSchema = z.object({
  responseMinLines: z.number().int().nonnegative().optional(),
  responseMaxLines: z.number().int().nonnegative().optional(),
  /** When true, hook only fires for workspaces with indexing enabled. */
  workspaceIndexingEnabled: z.boolean().optional(),
});

export const HubcodeHookSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  author: z.union([z.literal("builtin"), z.string()]),
  scope: z.enum(["global", "workspace"]),
  workspaceIds: z.array(z.string()).optional(),

  trigger: HookTriggerSchema,
  matcher: HookMatcherSchema,

  runtime: HookRuntimeSchema,
  /** Filesystem path (node/bash/python) OR inline script source. */
  source: z.string(),
  timeoutMs: z.number().int().positive().default(5_000),

  conditions: HookConditionsSchema.optional(),
  /**
   * Free-form tag list for the UI to group/filter. Built-ins use this for
   * category ("indexing", "safety", "productivity").
   */
  tags: z.array(z.string()).optional(),
});

export type HubcodeHook = z.infer<typeof HubcodeHookSchema>;
export type HookTrigger = z.infer<typeof HookTriggerSchema>;
export type HookRuntime = z.infer<typeof HookRuntimeSchema>;
export type CanonicalTool = z.infer<typeof CanonicalToolSchema>;

/**
 * Per-agent installation status of a hook. Surfaced in the Settings UI
 * so the user can see "installed on Claude Code, not installed on Codex
 * (unsupported)".
 */
export interface HookInstallStatus {
  agentId: string;
  status: "installed" | "not-installed" | "unsupported" | "error";
  reason?: string;
}

/** Runtime state layered on top of the static HubcodeHook definition. */
export interface HookRuntimeState {
  enabled: boolean;
  installStatus?: HookInstallStatus[];
  lastFiredAt?: string;
  firedCount?: number;
}

export interface HookWithState {
  definition: HubcodeHook;
  state: HookRuntimeState;
}

/**
 * Canonical tool mapping — per agent, which native tool names correspond
 * to each canonical identifier. Adapters read this to generate matcher
 * expressions native to the agent's hook system.
 */
export const AGENT_TOOL_MAP: Record<string, Record<CanonicalTool, string[]>> = {
  "claude-code": {
    read: ["Read"],
    grep: ["Grep"],
    glob: ["Glob"],
    edit: ["Edit", "MultiEdit"],
    write: ["Write"],
    bash: ["Bash"],
    task: ["Task"],
    fetch: ["WebFetch", "WebSearch"],
    todo: ["TodoWrite"],
    other: [],
  },
  codex: {
    // Codex tool names from its CLI surface. The adapter still no-ops until
    // we confirm Codex exposes a PostToolUse-equivalent hook mechanism.
    read: ["view_file", "read_file"],
    grep: ["search_code", "grep"],
    glob: ["list_files", "glob"],
    edit: ["apply_patch", "edit_file"],
    write: ["write_file", "create_file"],
    bash: ["run_shell", "shell"],
    task: [],
    fetch: ["fetch_url", "web_search"],
    todo: [],
    other: [],
  },
  opencode: {
    read: ["read"],
    grep: ["grep"],
    glob: ["glob"],
    edit: ["edit", "patch"],
    write: ["write"],
    bash: ["bash", "shell"],
    task: [],
    fetch: ["fetch"],
    todo: [],
    other: [],
  },
  "hubcode-gui": {
    // GUI agents run via Claude SDK, so the canonical ↔ native mapping is
    // the same as Claude Code.
    read: ["Read"],
    grep: ["Grep"],
    glob: ["Glob"],
    edit: ["Edit", "MultiEdit"],
    write: ["Write"],
    bash: ["Bash"],
    task: ["Task"],
    fetch: ["WebFetch", "WebSearch"],
    todo: ["TodoWrite"],
    other: [],
  },
};
