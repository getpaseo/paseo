import { authServerFetch } from "./auth-server-fetch";

// ─── Shared types (mirror of auth-server/src/lib/library/types.ts) ──────────

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

export const TRANSPORT_BY_TARGET: Record<LibrarySyncTarget, McpTransport[]> = {
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

// ─── HTTP ────────────────────────────────────────────────────────────────

export class LibraryApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LibraryApiError";
  }
}

interface FetchArgs {
  sessionToken: string | null;
}

async function request<T>(path: string, init: RequestInit & FetchArgs): Promise<T> {
  const res = await authServerFetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new LibraryApiError(
      res.status,
      body.code ?? "unknown",
      body.error ?? `HTTP ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── Library CRUD ────────────────────────────────────────────────────────

export async function listLibraryEntries(
  args: FetchArgs & { kind?: LibraryKind; scope?: LibraryScope; scopeId?: string },
): Promise<LibraryEntry[]> {
  const qs = new URLSearchParams();
  if (args.kind) qs.set("kind", args.kind);
  if (args.scope) qs.set("scope", args.scope);
  if (args.scopeId) qs.set("scopeId", args.scopeId);
  const body = await request<{ entries: LibraryEntry[] }>(
    `/api/library${qs.toString() ? `?${qs}` : ""}`,
    {
      sessionToken: args.sessionToken,
      method: "GET",
    },
  );
  return body.entries;
}

export async function createLibraryEntry(
  args: FetchArgs & {
    kind: LibraryKind;
    name: string;
    displayName?: string;
    description?: string | null;
    payload: LibraryPayload;
    iconUrl?: string | null;
    source?: LibrarySource;
    catalogId?: string | null;
    scope: LibraryScope;
    scopeId?: string | null;
    visibility?: LibraryVisibility;
  },
): Promise<LibraryEntry> {
  const { sessionToken, ...rest } = args;
  const body = await request<{ entry: LibraryEntry }>("/api/library", {
    sessionToken,
    method: "POST",
    body: JSON.stringify(rest),
  });
  return body.entry;
}

export async function updateLibraryEntry(
  args: FetchArgs & {
    entryId: string;
    displayName?: string;
    description?: string | null;
    payload?: LibraryPayload;
    iconUrl?: string | null;
    visibility?: LibraryVisibility;
  },
): Promise<LibraryEntry> {
  const { sessionToken, entryId, ...rest } = args;
  const body = await request<{ entry: LibraryEntry }>(
    `/api/library/${encodeURIComponent(entryId)}`,
    {
      sessionToken,
      method: "PATCH",
      body: JSON.stringify(rest),
    },
  );
  return body.entry;
}

export async function deleteLibraryEntry(args: FetchArgs & { entryId: string }): Promise<void> {
  await request(`/api/library/${encodeURIComponent(args.entryId)}`, {
    sessionToken: args.sessionToken,
    method: "DELETE",
  });
}

export async function setLibraryActivation(
  args: FetchArgs & {
    entryId: string;
    active?: boolean;
    syncTargets?: LibrarySyncTarget[];
  },
): Promise<LibraryEntry> {
  const { sessionToken, entryId, ...rest } = args;
  const body = await request<{ entry: LibraryEntry }>(
    `/api/library/${encodeURIComponent(entryId)}/activation`,
    {
      sessionToken,
      method: "PUT",
      body: JSON.stringify(rest),
    },
  );
  return body.entry;
}
