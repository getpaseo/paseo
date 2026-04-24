/**
 * Canonical types for the Library feature (MCP servers + Skills marketplace).
 * Wire-compatible with the daemon and app — keep additive: every new field
 * must be optional so old clients can still parse new server payloads.
 */

export type LibraryKind = "mcp" | "skill";
export type LibraryScope = "user" | "org" | "project";
export type LibraryVisibility = "private" | "shared";
export type LibrarySource = "custom" | "catalog";
export type LibrarySyncTarget =
  | "hubcode-gui"
  | "claude-code"
  | "codex"
  | "opencode"
  | "cursor"
  | "amp"
  | "gemini"
  | "qwen"
  | "copilot"
  | "droid"
  | "hermes"
  | "crush"
  | "auggie"
  | "goose"
  | "kimi"
  | "kilocode"
  | "kiro"
  | "rovodev"
  | "cline"
  | "continue"
  | "codebuff"
  | "vibe"
  | "pi"
  | "autohand"
  | "forge";

export type McpTransport = "stdio" | "http" | "sse";

export interface McpStdioPayload {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpPayload {
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export type McpPayload = McpStdioPayload | McpHttpPayload;

export interface SkillPayload {
  /** Inline markdown (used when the skill is small or user-authored). */
  instructionsInline?: string;
  /** External URL/path the daemon resolves at install time. */
  instructionsUrl?: string;
  /** Short prompt the UI surfaces in the detail view. */
  examplePrompt?: string;
}

export type LibraryPayload = McpPayload | SkillPayload;

export interface LibraryEntryRecord {
  id: string;
  kind: LibraryKind;
  name: string;
  displayName: string;
  description: string | null;
  payload: LibraryPayload;
  iconUrl: string | null;
  source: LibrarySource;
  catalogId: string | null;
  scope: LibraryScope;
  scopeId: string | null;
  visibility: LibraryVisibility;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Hydrated for the requesting user — null when activation row missing. */
  activation: LibraryActivationRecord | null;
}

export interface LibraryActivationRecord {
  active: boolean;
  syncTargets: LibrarySyncTarget[];
  activatedAt: string;
  updatedAt: string;
}

export interface LibraryListFilter {
  kind?: LibraryKind;
  scope?: LibraryScope;
  scopeId?: string;
}

/**
 * Which agent CLIs accept which MCP transports. Used both server-side (to
 * validate `syncTargets` on activation) and client-side (to disable the
 * toggles that don't apply).
 */
export const TRANSPORT_BY_TARGET: Record<LibrarySyncTarget, McpTransport[]> = {
  "hubcode-gui": ["stdio", "http", "sse"],
  "claude-code": ["stdio", "http", "sse"],
  codex: ["stdio"],
  opencode: ["stdio", "http", "sse"],
  cursor: ["stdio", "http"],
  amp: ["stdio", "http", "sse"],
  gemini: ["stdio", "http"],
  qwen: ["stdio", "http"],
  copilot: ["stdio", "http"],
  droid: ["stdio", "http"],
  hermes: [],
  crush: [],
  auggie: [],
  goose: [],
  kimi: [],
  kilocode: [],
  kiro: [],
  rovodev: [],
  cline: [],
  continue: [],
  codebuff: [],
  vibe: [],
  pi: [],
  autohand: [],
  forge: [],
};

export function targetSupportsTransport(
  target: LibrarySyncTarget,
  transport: McpTransport,
): boolean {
  return TRANSPORT_BY_TARGET[target].includes(transport);
}
