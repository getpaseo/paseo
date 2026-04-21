/**
 * Local mirror of auth-server library types. Kept narrow to what the CLI
 * actually reads/writes — the wire format is shared with the GUI.
 */

export type LibraryKind = "mcp" | "skill";
export type LibraryScope = "user" | "org" | "project";
export type LibraryVisibility = "private" | "shared";
export type LibrarySource = "custom" | "catalog";
export type LibrarySyncTarget =
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
  instructionsInline?: string;
  instructionsUrl?: string;
  examplePrompt?: string;
}

export type LibraryPayload = McpPayload | SkillPayload;

export interface LibraryActivation {
  active: boolean;
  syncTargets: LibrarySyncTarget[];
  activatedAt: string;
  updatedAt: string;
}

export interface LibraryEntry {
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
  activation: LibraryActivation | null;
}

export const VALID_SCOPES: LibraryScope[] = ["user", "org", "project"];
export const VALID_VISIBILITY: LibraryVisibility[] = ["private", "shared"];
export const VALID_TARGETS: LibrarySyncTarget[] = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "amp",
  "gemini",
  "qwen",
  "copilot",
  "droid",
  "hermes",
  "crush",
  "auggie",
  "goose",
  "kimi",
  "kilocode",
  "kiro",
  "rovodev",
  "cline",
  "continue",
  "codebuff",
  "vibe",
  "pi",
  "autohand",
  "forge",
];
export const VALID_TRANSPORTS: McpTransport[] = ["stdio", "http", "sse"];
