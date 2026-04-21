/**
 * Normalized shape the app/CLI consumes — independent of upstream API
 * peculiarities. Every source adapter maps its raw payload to this type
 * before the cache stores it, so the UI never cares about differences
 * between PulseMCP / GitHub / skills.sh.
 */
export interface CatalogItem {
  /** Stable cross-source identifier, e.g. "pulsemcp:playwright". */
  id: string;
  kind: "mcp" | "skill";
  /** Human name as shown on the card. */
  name: string;
  /** Short description (≤200 chars ideally). */
  description: string;
  /** Remote icon URL — usually a GitHub avatar. null → render fallback glyph. */
  iconUrl: string | null;
  /** Upstream page we can link to for more info. */
  homepage: string | null;
  /** MCP-only: known transports supported by this server. */
  transports?: Array<"stdio" | "http" | "sse">;
  /** MCP-only: suggested install command when we can infer one. */
  install?: {
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    envVars?: string[];
  };
  /** Skill-only: optional inline body preview shown in the detail modal. */
  instructionsUrl?: string;
  examplePrompt?: string;
  /** Popularity hint (GitHub stars etc) — used for ranking. */
  popularity?: number;
  /** Source this came from; useful for filtering + de-dup strategies. */
  source: "pulsemcp" | "smithery" | "anthropic-skills" | "openai-skills" | "skills-sh";
}

export interface CatalogPage {
  items: CatalogItem[];
  /** Opaque cursor for the next page; null when exhausted. */
  nextCursor: string | null;
  /** Upstream total count when known; -1 when unknown. */
  totalCount: number;
}
