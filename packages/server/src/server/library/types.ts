/**
 * Library types used by daemon-side code (sync writers, etc.). Mirrors the
 * shape sent over the WebSocket from auth-server clients.
 */

export type LibraryKind = "mcp" | "skill";
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
  instructionsInline?: string;
  instructionsUrl?: string;
  examplePrompt?: string;
}

export interface MaterializedMcpEntry {
  /** Stable identifier; used as the key in target configs. */
  id: string;
  /** Human-friendly key — "playwright", "github", etc. Slug. */
  name: string;
  payload: McpPayload;
  syncTargets: LibrarySyncTarget[];
}

export interface MaterializedSkillEntry {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  payload: SkillPayload;
  syncTargets: LibrarySyncTarget[];
}

// Targets without an MCP adapter yet get an empty list — UI will grey the
// transport toggle for them. Skills still sync (folder + symlink only).
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
